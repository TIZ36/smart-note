from __future__ import annotations

import json
from pathlib import Path

from app.db import connect


IMAGE_DIR = Path(__file__).resolve().parent.parent / "data" / "smart_table_images"


def _touch_table(conn, table_id: int) -> None:
    conn.execute(
        "UPDATE smart_tables SET updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        (table_id,),
    )


def _touch_sheet(conn, sheet_id: int) -> int:
    row = conn.execute(
        "SELECT table_id FROM smart_table_sheets WHERE id = ?",
        (sheet_id,),
    ).fetchone()
    if not row:
        raise ValueError("Sheet not found")
    conn.execute(
        "UPDATE smart_table_sheets SET updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        (sheet_id,),
    )
    _touch_table(conn, row["table_id"])
    return int(row["table_id"])


def _touch_row(conn, row_id: int) -> tuple[int, int]:
    row = conn.execute(
        "SELECT sheet_id FROM smart_table_rows WHERE id = ?",
        (row_id,),
    ).fetchone()
    if not row:
        raise ValueError("Row not found")
    conn.execute(
        "UPDATE smart_table_rows SET updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        (row_id,),
    )
    table_id = _touch_sheet(conn, int(row["sheet_id"]))
    return int(row["sheet_id"]), table_id


def _get_table_by_name(conn, name: str):
    row = conn.execute(
        "SELECT id, name, created_at, updated_at FROM smart_tables WHERE name = ?",
        (name,),
    ).fetchone()
    if not row:
        raise ValueError(f"Table not found: {name}")
    return row


def _get_sheet_by_name(conn, table_id: int, sheet_name: str):
    row = conn.execute(
        """
        SELECT id, table_id, name, ord, created_at, updated_at
        FROM smart_table_sheets
        WHERE table_id = ? AND name = ?
        """,
        (table_id, sheet_name),
    ).fetchone()
    if not row:
        raise ValueError(f"Sheet not found: {sheet_name}")
    return row


def _get_column_by_name(conn, sheet_id: int, column_name: str):
    row = conn.execute(
        """
        SELECT id, sheet_id, name, type, ord, created_at, updated_at
        FROM smart_table_columns
        WHERE sheet_id = ? AND name = ?
        """,
        (sheet_id, column_name),
    ).fetchone()
    if not row:
        raise ValueError(f"Column not found: {column_name}")
    return row


def _next_ord(
    conn, table: str, fk_name: str | None = None, fk_value: int | None = None
) -> int:
    sql = f"SELECT COALESCE(MAX(ord), -1) + 1 FROM {table}"
    args: tuple[int, ...] = ()
    if fk_name is not None and fk_value is not None:
        sql += f" WHERE {fk_name} = ?"
        args = (fk_value,)
    return int(conn.execute(sql, args).fetchone()[0])


def _decode_value(raw: str) -> dict:
    value = json.loads(raw)
    return value if isinstance(value, dict) else {"value": value}


def _encode_value(value: dict | str) -> str:
    payload = value if isinstance(value, dict) else {"value": value}
    return json.dumps(payload, ensure_ascii=False)


def _sheet_payload(conn, sheet_id: int) -> dict:
    sheet = conn.execute(
        """
        SELECT s.id, s.table_id, s.name, s.ord, s.created_at, s.updated_at, t.name AS table_name
        FROM smart_table_sheets s
        JOIN smart_tables t ON t.id = s.table_id
        WHERE s.id = ?
        """,
        (sheet_id,),
    ).fetchone()
    if not sheet:
        raise ValueError("Sheet not found")

    columns = conn.execute(
        """
        SELECT id, sheet_id, name, type, ord, created_at, updated_at
        FROM smart_table_columns
        WHERE sheet_id = ?
        ORDER BY ord ASC, id ASC
        """,
        (sheet_id,),
    ).fetchall()

    rows = conn.execute(
        """
        SELECT r.id, r.sheet_id, r.ord, r.created_at, r.updated_at,
               c.column_id, c.value_json
        FROM smart_table_rows r
        LEFT JOIN smart_table_cells c ON c.row_id = r.id
        WHERE r.sheet_id = ?
        ORDER BY r.ord ASC, r.id ASC
        """,
        (sheet_id,),
    ).fetchall()

    row_map: dict[int, dict] = {}
    for row in rows:
        row_id = int(row["id"])
        item = row_map.setdefault(
            row_id,
            {
                "id": row_id,
                "sheet_id": int(row["sheet_id"]),
                "ord": int(row["ord"]),
                "created_at": row["created_at"],
                "updated_at": row["updated_at"],
                "cells": {},
            },
        )
        if row["column_id"] is not None:
            item["cells"][int(row["column_id"])] = _decode_value(row["value_json"])

    return {
        "sheet": {
            "id": int(sheet["id"]),
            "table_id": int(sheet["table_id"]),
            "table_name": sheet["table_name"],
            "name": sheet["name"],
            "ord": int(sheet["ord"]),
            "created_at": sheet["created_at"],
            "updated_at": sheet["updated_at"],
        },
        "columns": [
            {
                "id": int(col["id"]),
                "sheet_id": int(col["sheet_id"]),
                "name": col["name"],
                "type": col["type"],
                "ord": int(col["ord"]),
                "created_at": col["created_at"],
                "updated_at": col["updated_at"],
            }
            for col in columns
        ],
        "rows": list(row_map.values()),
    }


def list_tables() -> list[dict]:
    with connect() as conn:
        rows = conn.execute(
            """
            SELECT t.id, t.name, t.created_at, t.updated_at,
                   COUNT(DISTINCT s.id) AS sheet_count,
                   COUNT(DISTINCT r.id) AS row_count
            FROM smart_tables t
            LEFT JOIN smart_table_sheets s ON s.table_id = t.id
            LEFT JOIN smart_table_rows r ON r.sheet_id = s.id
            GROUP BY t.id
            ORDER BY t.updated_at DESC, t.id DESC
            """
        ).fetchall()
    return [
        {
            "id": int(row["id"]),
            "name": row["name"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
            "sheet_count": int(row["sheet_count"]),
            "row_count": int(row["row_count"]),
        }
        for row in rows
    ]


def create_table(name: str) -> dict:
    with connect() as conn:
        conn.execute(
            "INSERT INTO smart_tables(name) VALUES (?)",
            (name,),
        )
        table_id = int(conn.execute("SELECT last_insert_rowid()").fetchone()[0])
        conn.commit()
        row = conn.execute(
            "SELECT id, name, created_at, updated_at FROM smart_tables WHERE id = ?",
            (table_id,),
        ).fetchone()
    return {
        "id": int(row["id"]),
        "name": row["name"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def rename_table(table_name: str, new_name: str) -> dict:
    with connect() as conn:
        table = _get_table_by_name(conn, table_name)
        conn.execute(
            "UPDATE smart_tables SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            (new_name, table["id"]),
        )
        conn.commit()
        row = conn.execute(
            "SELECT id, name, created_at, updated_at FROM smart_tables WHERE id = ?",
            (table["id"],),
        ).fetchone()
    return {
        "id": int(row["id"]),
        "name": row["name"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def delete_table(table_name: str) -> dict:
    with connect() as conn:
        table = _get_table_by_name(conn, table_name)
        conn.execute("DELETE FROM smart_tables WHERE id = ?", (table["id"],))
        conn.commit()
    return {"ok": True, "deleted_table": table_name}


def list_sheets(table_name: str) -> list[dict]:
    with connect() as conn:
        table = _get_table_by_name(conn, table_name)
        rows = conn.execute(
            """
            SELECT s.id, s.table_id, s.name, s.ord, s.created_at, s.updated_at,
                   COUNT(DISTINCT c.id) AS column_count,
                   COUNT(DISTINCT r.id) AS row_count
            FROM smart_table_sheets s
            LEFT JOIN smart_table_columns c ON c.sheet_id = s.id
            LEFT JOIN smart_table_rows r ON r.sheet_id = s.id
            WHERE s.table_id = ?
            GROUP BY s.id
            ORDER BY s.ord ASC, s.id ASC
            """,
            (table["id"],),
        ).fetchall()
    return [
        {
            "id": int(row["id"]),
            "table_id": int(row["table_id"]),
            "name": row["name"],
            "ord": int(row["ord"]),
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
            "column_count": int(row["column_count"]),
            "row_count": int(row["row_count"]),
        }
        for row in rows
    ]


def create_sheet(table_name: str, sheet_name: str) -> dict:
    with connect() as conn:
        table = _get_table_by_name(conn, table_name)
        ord_value = _next_ord(conn, "smart_table_sheets", "table_id", int(table["id"]))
        conn.execute(
            "INSERT INTO smart_table_sheets(table_id, name, ord) VALUES (?, ?, ?)",
            (table["id"], sheet_name, ord_value),
        )
        sheet_id = int(conn.execute("SELECT last_insert_rowid()").fetchone()[0])
        _touch_table(conn, int(table["id"]))
        conn.commit()
        return _sheet_payload(conn, sheet_id)["sheet"]


def rename_sheet(table_name: str, sheet_name: str, new_name: str) -> dict:
    with connect() as conn:
        table = _get_table_by_name(conn, table_name)
        sheet = _get_sheet_by_name(conn, int(table["id"]), sheet_name)
        conn.execute(
            """
            UPDATE smart_table_sheets
            SET name = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
            """,
            (new_name, sheet["id"]),
        )
        _touch_table(conn, int(table["id"]))
        conn.commit()
        return _sheet_payload(conn, int(sheet["id"]))["sheet"]


def delete_sheet(table_name: str, sheet_name: str) -> dict:
    with connect() as conn:
        table = _get_table_by_name(conn, table_name)
        sheet = _get_sheet_by_name(conn, int(table["id"]), sheet_name)
        conn.execute("DELETE FROM smart_table_sheets WHERE id = ?", (sheet["id"],))
        _touch_table(conn, int(table["id"]))
        conn.commit()
    return {"ok": True, "deleted_sheet": sheet_name}


def add_column(
    table_name: str, sheet_name: str, column_name: str, column_type: str
) -> dict:
    with connect() as conn:
        table = _get_table_by_name(conn, table_name)
        sheet = _get_sheet_by_name(conn, int(table["id"]), sheet_name)
        ord_value = _next_ord(conn, "smart_table_columns", "sheet_id", int(sheet["id"]))
        conn.execute(
            """
            INSERT INTO smart_table_columns(sheet_id, name, type, ord)
            VALUES (?, ?, ?, ?)
            """,
            (sheet["id"], column_name, column_type, ord_value),
        )
        column_id = int(conn.execute("SELECT last_insert_rowid()").fetchone()[0])
        _touch_sheet(conn, int(sheet["id"]))
        conn.commit()
        row = conn.execute(
            """
            SELECT id, sheet_id, name, type, ord, created_at, updated_at
            FROM smart_table_columns
            WHERE id = ?
            """,
            (column_id,),
        ).fetchone()
    return {
        "id": int(row["id"]),
        "sheet_id": int(row["sheet_id"]),
        "name": row["name"],
        "type": row["type"],
        "ord": int(row["ord"]),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def rename_column(
    table_name: str, sheet_name: str, column_name: str, new_name: str
) -> dict:
    with connect() as conn:
        table = _get_table_by_name(conn, table_name)
        sheet = _get_sheet_by_name(conn, int(table["id"]), sheet_name)
        column = _get_column_by_name(conn, int(sheet["id"]), column_name)
        conn.execute(
            """
            UPDATE smart_table_columns
            SET name = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
            """,
            (new_name, column["id"]),
        )
        _touch_sheet(conn, int(sheet["id"]))
        conn.commit()
        row = conn.execute(
            "SELECT id, sheet_id, name, type, ord, created_at, updated_at FROM smart_table_columns WHERE id = ?",
            (column["id"],),
        ).fetchone()
    return {
        "id": int(row["id"]),
        "sheet_id": int(row["sheet_id"]),
        "name": row["name"],
        "type": row["type"],
        "ord": int(row["ord"]),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def delete_column(table_name: str, sheet_name: str, column_name: str) -> dict:
    with connect() as conn:
        table = _get_table_by_name(conn, table_name)
        sheet = _get_sheet_by_name(conn, int(table["id"]), sheet_name)
        column = _get_column_by_name(conn, int(sheet["id"]), column_name)
        conn.execute("DELETE FROM smart_table_columns WHERE id = ?", (column["id"],))
        _touch_sheet(conn, int(sheet["id"]))
        conn.commit()
    return {"ok": True, "deleted_column": column_name}


def add_row(
    table_name: str,
    sheet_name: str,
    values: dict[str, dict | str] | None = None,
    source: str = "ui",
) -> dict:
    with connect() as conn:
        table = _get_table_by_name(conn, table_name)
        sheet = _get_sheet_by_name(conn, int(table["id"]), sheet_name)
        ord_value = _next_ord(conn, "smart_table_rows", "sheet_id", int(sheet["id"]))
        conn.execute(
            "INSERT INTO smart_table_rows(sheet_id, ord) VALUES (?, ?)",
            (sheet["id"], ord_value),
        )
        row_id = int(conn.execute("SELECT last_insert_rowid()").fetchone()[0])
        if values:
            for col_name, value in values.items():
                column = _get_column_by_name(conn, int(sheet["id"]), col_name)
                _write_cell(conn, row_id, int(column["id"]), value, source)
        _touch_sheet(conn, int(sheet["id"]))
        conn.commit()
        row = conn.execute(
            "SELECT id, sheet_id, ord, created_at, updated_at FROM smart_table_rows WHERE id = ?",
            (row_id,),
        ).fetchone()
    return {
        "id": int(row["id"]),
        "sheet_id": int(row["sheet_id"]),
        "ord": int(row["ord"]),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def delete_row(table_name: str, sheet_name: str, row_id: int) -> dict:
    with connect() as conn:
        table = _get_table_by_name(conn, table_name)
        sheet = _get_sheet_by_name(conn, int(table["id"]), sheet_name)
        row = conn.execute(
            "SELECT id FROM smart_table_rows WHERE id = ? AND sheet_id = ?",
            (row_id, sheet["id"]),
        ).fetchone()
        if not row:
            raise ValueError(f"Row not found: {row_id}")
        conn.execute("DELETE FROM smart_table_rows WHERE id = ?", (row_id,))
        _touch_sheet(conn, int(sheet["id"]))
        conn.commit()
    return {"ok": True, "deleted_row_id": row_id}


def get_sheet(table_name: str, sheet_name: str) -> dict:
    with connect() as conn:
        table = _get_table_by_name(conn, table_name)
        sheet = _get_sheet_by_name(conn, int(table["id"]), sheet_name)
        return _sheet_payload(conn, int(sheet["id"]))


def _write_cell(
    conn, row_id: int, column_id: int, value: dict | str, source: str
) -> None:
    encoded = _encode_value(value)
    existing = conn.execute(
        "SELECT value_json FROM smart_table_cells WHERE row_id = ? AND column_id = ?",
        (row_id, column_id),
    ).fetchone()
    old_value = existing["value_json"] if existing else None
    if old_value == encoded:
        return

    conn.execute(
        """
        INSERT INTO smart_table_cells(row_id, column_id, value_json, updated_at)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(row_id, column_id) DO UPDATE SET
          value_json = excluded.value_json,
          updated_at = CURRENT_TIMESTAMP
        """,
        (row_id, column_id, encoded),
    )
    conn.execute(
        """
        INSERT INTO smart_table_cell_history(row_id, column_id, old_value, new_value, source)
        VALUES (?, ?, ?, ?, ?)
        """,
        (row_id, column_id, old_value, encoded, source),
    )
    _touch_row(conn, row_id)


def update_cell(
    table_name: str,
    sheet_name: str,
    row_id: int,
    column_name: str,
    value: dict | str,
    source: str = "ui",
) -> dict:
    with connect() as conn:
        table = _get_table_by_name(conn, table_name)
        sheet = _get_sheet_by_name(conn, int(table["id"]), sheet_name)
        row = conn.execute(
            "SELECT id FROM smart_table_rows WHERE id = ? AND sheet_id = ?",
            (row_id, sheet["id"]),
        ).fetchone()
        if not row:
            raise ValueError(f"Row not found: {row_id}")
        column = _get_column_by_name(conn, int(sheet["id"]), column_name)
        _write_cell(conn, int(row_id), int(column["id"]), value, source)
        conn.commit()
        return _sheet_payload(conn, int(sheet["id"]))


def append_column_data(
    table_name: str,
    sheet_name: str,
    column_name: str,
    values: list[dict | str],
    source: str = "mcp",
) -> dict:
    with connect() as conn:
        table = _get_table_by_name(conn, table_name)
        sheet = _get_sheet_by_name(conn, int(table["id"]), sheet_name)
        column = _get_column_by_name(conn, int(sheet["id"]), column_name)

        row_ids = [
            int(row["id"])
            for row in conn.execute(
                "SELECT id FROM smart_table_rows WHERE sheet_id = ? ORDER BY ord ASC, id ASC",
                (sheet["id"],),
            ).fetchall()
        ]

        appended = 0
        for index, value in enumerate(values):
            if index < len(row_ids):
                row_id = row_ids[index]
            else:
                ord_value = _next_ord(
                    conn, "smart_table_rows", "sheet_id", int(sheet["id"])
                )
                conn.execute(
                    "INSERT INTO smart_table_rows(sheet_id, ord) VALUES (?, ?)",
                    (sheet["id"], ord_value),
                )
                row_id = int(conn.execute("SELECT last_insert_rowid()").fetchone()[0])
                row_ids.append(row_id)
                appended += 1
            _write_cell(conn, row_id, int(column["id"]), value, source)

        conn.commit()
        payload = _sheet_payload(conn, int(sheet["id"]))
        payload["appended_rows"] = appended
        payload["written_values"] = len(values)
        return payload


def insert_rows(
    table_name: str,
    sheet_name: str,
    rows: list[dict[str, dict | str]],
    source: str = "mcp",
) -> dict:
    created = []
    with connect() as conn:
        table = _get_table_by_name(conn, table_name)
        sheet = _get_sheet_by_name(conn, int(table["id"]), sheet_name)
        sheet_id = int(sheet["id"])
        for row_values in rows:
            ord_value = _next_ord(conn, "smart_table_rows", "sheet_id", sheet_id)
            conn.execute(
                "INSERT INTO smart_table_rows(sheet_id, ord) VALUES (?, ?)",
                (sheet_id, ord_value),
            )
            row_id = int(conn.execute("SELECT last_insert_rowid()").fetchone()[0])
            for col_name, value in row_values.items():
                column = _get_column_by_name(conn, sheet_id, col_name)
                _write_cell(conn, row_id, int(column["id"]), value, source)
            created.append(row_id)
        _touch_sheet(conn, sheet_id)
        conn.commit()
        payload = _sheet_payload(conn, sheet_id)
        payload["inserted_row_ids"] = created
        payload["written_rows"] = len(created)
        return payload


def get_cell_history(
    table_name: str, sheet_name: str, row_id: int, column_name: str
) -> list[dict]:
    with connect() as conn:
        table = _get_table_by_name(conn, table_name)
        sheet = _get_sheet_by_name(conn, int(table["id"]), sheet_name)
        column = _get_column_by_name(conn, int(sheet["id"]), column_name)
        rows = conn.execute(
            """
            SELECT id, row_id, column_id, old_value, new_value, changed_at, source
            FROM smart_table_cell_history
            WHERE row_id = ? AND column_id = ?
            ORDER BY id DESC
            """,
            (row_id, column["id"]),
        ).fetchall()
    return [
        {
            "id": int(row["id"]),
            "row_id": int(row["row_id"]),
            "column_id": int(row["column_id"]),
            "old_value": _decode_value(row["old_value"]) if row["old_value"] else None,
            "new_value": _decode_value(row["new_value"]) if row["new_value"] else None,
            "changed_at": row["changed_at"],
            "source": row["source"],
        }
        for row in rows
    ]


def save_image(filename: str, content: bytes) -> dict:
    IMAGE_DIR.mkdir(parents=True, exist_ok=True)
    safe_name = Path(filename).name or "image.bin"
    target = IMAGE_DIR / safe_name
    stem = target.stem
    suffix = target.suffix
    counter = 1
    while target.exists():
        target = IMAGE_DIR / f"{stem}-{counter}{suffix}"
        counter += 1
    target.write_bytes(content)
    relative = target.relative_to(IMAGE_DIR.parent)
    return {
        "filename": target.name,
        "relative_path": str(relative).replace("\\", "/"),
        "url": f"/smart-table-images/{target.name}",
    }
