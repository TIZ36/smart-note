"""Skill template storage.

Notes record meaningful skills — reusable recipes any CLI (Claude Code,
Cursor, OpenCode) can benefit from without re-recording. SmartNote stores
the recipe; it does NOT execute it.

Responsibilities:
  - CRUD on `skill_templates` (ordered list of steps as JSON)
  - Trigger a pending run (creates the row, returns the bundle the CLI needs:
    template + time-sliced note chunks to work on)
  - Accept a result write-back once the CLI has executed it
  - Slice notes by `chunks.note_ts` (user write time, not ingest time) so
    "this week's skill run" means notes written this week
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from typing import Any

from app.db import connect


# ── Template CRUD ─────────────────────────────────────────────────

def save_template(
    name: str,
    description: str,
    nodes: list[dict],
    kind: str = "periodic",
    period_hint: str = "weekly",
    source_segment_ids: list[int] | None = None,
) -> dict:
    """Insert or update a skill template. `nodes` is the ordered list of
    steps each with {name, description, trigger_hints[], expected_tag}."""
    name = (name or "").strip()
    if not name:
        raise ValueError("template name required")
    kind = kind if kind in ("periodic", "sequence") else "periodic"
    period_hint = period_hint if period_hint in ("daily", "weekly", "monthly", "ad_hoc") else "weekly"
    nodes_json = json.dumps(nodes or [], ensure_ascii=False)
    src_json = json.dumps(source_segment_ids or [], ensure_ascii=False)
    now = _now_iso()

    with connect() as conn:
        row = conn.execute(
            "SELECT id FROM skill_templates WHERE name = ?", (name,)
        ).fetchone()
        if row:
            conn.execute(
                "UPDATE skill_templates SET description = ?, kind = ?, "
                "period_hint = ?, nodes_json = ?, source_segment_ids = ?, "
                "updated_at = ? WHERE id = ?",
                (description, kind, period_hint, nodes_json, src_json, now, row["id"]),
            )
            tid = row["id"]
        else:
            cur = conn.execute(
                "INSERT INTO skill_templates(name, description, kind, "
                "period_hint, nodes_json, source_segment_ids, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (name, description, kind, period_hint, nodes_json, src_json, now, now),
            )
            tid = cur.lastrowid
        conn.commit()
    return get_template(tid)


def list_templates() -> list[dict]:
    with connect() as conn:
        rows = conn.execute(
            "SELECT id, name, description, kind, period_hint, nodes_json, "
            "source_segment_ids, created_at, updated_at "
            "FROM skill_templates ORDER BY updated_at DESC"
        ).fetchall()
    return [_row_to_template(r) for r in rows]


def get_template(template_id_or_name: int | str) -> dict:
    with connect() as conn:
        if isinstance(template_id_or_name, int):
            row = conn.execute(
                "SELECT * FROM skill_templates WHERE id = ?", (template_id_or_name,)
            ).fetchone()
        else:
            row = conn.execute(
                "SELECT * FROM skill_templates WHERE name = ?", (template_id_or_name,)
            ).fetchone()
    if not row:
        raise KeyError(f"skill template not found: {template_id_or_name}")
    return _row_to_template(row)


_EDITABLE_NODE_FIELDS = {"name", "description", "trigger_hints", "expected_tag"}


def patch_template(
    name: str,
    *,
    description: str | None = None,
    new_name: str | None = None,
    kind: str | None = None,
    period_hint: str | None = None,
    node_patches: list[dict] | None = None,
) -> dict:
    """Apply a partial update to a template. Only the fields present are
    touched. `node_patches` is a list of {index, <editable_field>: value}
    entries; the node's position in the list is identified by `index`.

    Structural changes (adding/removing/reordering nodes) are explicitly
    rejected — pass `save_template` with the full new nodes array if you
    need that. Here we preserve the skill's topology.
    """
    template = get_template(name)
    updates: list[str] = []
    args: list = []

    if description is not None:
        updates.append("description = ?")
        args.append(description)
    if kind is not None:
        if kind not in ("periodic", "sequence"):
            raise ValueError(f"invalid kind: {kind}")
        updates.append("kind = ?")
        args.append(kind)
    if period_hint is not None:
        if period_hint not in ("daily", "weekly", "monthly", "ad_hoc"):
            raise ValueError(f"invalid period_hint: {period_hint}")
        updates.append("period_hint = ?")
        args.append(period_hint)

    # Node-level patches: mutate the existing nodes array in-place without
    # altering length or ordering. Each patch must carry `index`.
    if node_patches:
        nodes = list(template["nodes"])
        for patch in node_patches:
            idx = patch.get("index")
            if not isinstance(idx, int) or idx < 0 or idx >= len(nodes):
                raise ValueError(f"node patch index out of range: {idx}")
            for field, value in patch.items():
                if field == "index":
                    continue
                if field not in _EDITABLE_NODE_FIELDS:
                    raise ValueError(f"node field not editable: {field}")
                nodes[idx][field] = value
        updates.append("nodes_json = ?")
        args.append(json.dumps(nodes, ensure_ascii=False))

    if new_name is not None:
        new_name = new_name.strip()
        if not new_name:
            raise ValueError("new_name must be non-empty")
        if new_name != template["name"]:
            with connect() as conn:
                existing = conn.execute(
                    "SELECT 1 FROM skill_templates WHERE name = ? AND id != ?",
                    (new_name, template["id"]),
                ).fetchone()
            if existing:
                raise ValueError(f"name already taken: {new_name}")
            updates.append("name = ?")
            args.append(new_name)

    if not updates:
        return template

    updates.append("updated_at = ?")
    args.append(_now_iso())
    args.append(template["id"])

    with connect() as conn:
        conn.execute(
            f"UPDATE skill_templates SET {', '.join(updates)} WHERE id = ?",
            args,
        )
        conn.commit()

    return get_template(template["id"])


def delete_template(template_id: int) -> int:
    with connect() as conn:
        conn.execute("DELETE FROM skill_runs WHERE template_id = ?", (template_id,))
        cur = conn.execute("DELETE FROM skill_templates WHERE id = ?", (template_id,))
        conn.commit()
        return cur.rowcount


# ── Note slicing (the `note_ts` metadata pays off here) ──────────

def slice_notes(
    slice_start_ts: str | None = None,
    slice_end_ts: str | None = None,
    days: int | None = None,
    limit: int = 200,
) -> dict:
    """Return chunks whose note_ts falls in the slice. If `days` is given,
    slice is [now - days, now]. Used by run bundles so the executing CLI has
    exactly the notes it needs to apply the template to."""
    if days is not None and not (slice_start_ts or slice_end_ts):
        end = datetime.now(timezone.utc)
        start = end - timedelta(days=max(1, int(days)))
        slice_start_ts = start.strftime("%Y-%m-%d %H:%M:%S")
        slice_end_ts = end.strftime("%Y-%m-%d %H:%M:%S")

    if not slice_start_ts or not slice_end_ts:
        raise ValueError("provide either (slice_start_ts, slice_end_ts) or days")

    with connect() as conn:
        rows = conn.execute(
            "SELECT id, source_ref, text, dimension, ai_summary, keywords_json, "
            "note_ts, created_at "
            "FROM chunks "
            "WHERE COALESCE(note_ts, created_at) BETWEEN ? AND ? "
            "ORDER BY COALESCE(note_ts, created_at) ASC "
            "LIMIT ?",
            (slice_start_ts, slice_end_ts, limit),
        ).fetchall()

    return {
        "slice_start_ts": slice_start_ts,
        "slice_end_ts": slice_end_ts,
        "chunk_count": len(rows),
        "chunks": [
            {
                "id": r["id"],
                "source_ref": r["source_ref"],
                "text": r["text"],
                "dimension": r["dimension"],
                "summary": r["ai_summary"],
                "keywords": _safe_json(r["keywords_json"], []),
                "note_ts": r["note_ts"] or r["created_at"],
            }
            for r in rows
        ],
    }


# ── Runs ──────────────────────────────────────────────────────────

def trigger_run(
    template_name: str,
    slice_days: int = 7,
    triggered_by: str = "ui",
) -> dict:
    """Create a pending run. Returns the run record + bundle (template + notes
    slice) that the MCP caller will read to execute."""
    template = get_template(template_name)
    sliced = slice_notes(days=slice_days)

    with connect() as conn:
        cur = conn.execute(
            "INSERT INTO skill_runs(template_id, slice_start_ts, slice_end_ts, "
            "status, triggered_by, started_at) VALUES (?, ?, ?, 'pending_exec', ?, ?)",
            (template["id"], sliced["slice_start_ts"], sliced["slice_end_ts"],
             triggered_by, _now_iso()),
        )
        conn.commit()
        run_id = cur.lastrowid

    return {
        "run": get_run(run_id),
        "bundle": {
            "template": template,
            "slice": sliced,
        },
    }


def record_run_result(
    run_id: int,
    status: str,
    result_summary: str = "",
    steps: list[dict] | None = None,
) -> dict:
    """Called by the CLI after executing the skill.
    status: 'completed' | 'skipped'. 'skipped' means the slice didn't match
    the pattern — which is fine, not an error."""
    if status not in ("completed", "skipped"):
        raise ValueError("status must be completed or skipped")
    steps_json = json.dumps(steps or [], ensure_ascii=False)
    finished = _now_iso()

    with connect() as conn:
        row = conn.execute(
            "SELECT id FROM skill_runs WHERE id = ?", (run_id,)
        ).fetchone()
        if not row:
            raise KeyError(f"run not found: {run_id}")
        conn.execute(
            "UPDATE skill_runs SET status = ?, result_summary = ?, "
            "steps_json = ?, finished_at = ? WHERE id = ?",
            (status, result_summary, steps_json, finished, run_id),
        )
        conn.commit()
    return get_run(run_id)


def list_runs(
    template_id: int | None = None,
    status: str | None = None,
    limit: int = 30,
) -> list[dict]:
    q = "SELECT * FROM skill_runs WHERE 1=1"
    args: list[Any] = []
    if template_id is not None:
        q += " AND template_id = ?"
        args.append(template_id)
    if status:
        q += " AND status = ?"
        args.append(status)
    q += " ORDER BY started_at DESC LIMIT ?"
    args.append(limit)

    with connect() as conn:
        rows = conn.execute(q, args).fetchall()
    return [_row_to_run(r) for r in rows]


def get_run(run_id: int) -> dict:
    with connect() as conn:
        row = conn.execute(
            "SELECT * FROM skill_runs WHERE id = ?", (run_id,)
        ).fetchone()
    if not row:
        raise KeyError(f"run not found: {run_id}")
    return _row_to_run(row)


def get_run_bundle(run_id: int) -> dict:
    """Rehydrate the full (template + slice) bundle so a CLI picking up an
    old pending run has everything it needs."""
    run = get_run(run_id)
    template = get_template(run["template_id"])
    sliced = slice_notes(
        slice_start_ts=run["slice_start_ts"],
        slice_end_ts=run["slice_end_ts"],
    )
    return {"run": run, "template": template, "slice": sliced}


# ── internals ─────────────────────────────────────────────────────

def _row_to_template(row) -> dict:
    return {
        "id": row["id"],
        "name": row["name"],
        "description": row["description"],
        "kind": row["kind"],
        "period_hint": row["period_hint"],
        "nodes": _safe_json(row["nodes_json"], []),
        "source_segment_ids": _safe_json(row["source_segment_ids"], []),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def _row_to_run(row) -> dict:
    return {
        "id": row["id"],
        "template_id": row["template_id"],
        "slice_start_ts": row["slice_start_ts"],
        "slice_end_ts": row["slice_end_ts"],
        "status": row["status"],
        "result_summary": row["result_summary"],
        "steps": _safe_json(row["steps_json"], []),
        "triggered_by": row["triggered_by"],
        "started_at": row["started_at"],
        "finished_at": row["finished_at"],
    }


def _safe_json(s: str | None, fallback):
    if not s:
        return fallback
    try:
        return json.loads(s)
    except (json.JSONDecodeError, TypeError):
        return fallback


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
