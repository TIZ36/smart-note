"""Build management — each ingest creates a build ID, only one is active at a time."""

from __future__ import annotations

import json
from datetime import datetime

from app.db import connect


def create_build(source_file: str) -> str:
    """Create a new build and return its ID."""
    build_id = datetime.now().strftime("%Y%m%d_%H%M%S")
    with connect() as conn:
        conn.execute(
            "INSERT INTO builds(id, source_file) VALUES(?, ?)",
            (build_id, source_file),
        )
        conn.commit()
    return build_id


def activate_build(build_id: str) -> None:
    """Set a build as the active one (deactivate all others)."""
    with connect() as conn:
        conn.execute("UPDATE builds SET is_active = 0")
        conn.execute("UPDATE builds SET is_active = 1 WHERE id = ?", (build_id,))
        conn.commit()


def finalize_build(
    build_id: str,
    chunk_count: int,
    segment_count: int,
    tags: dict[str, int],
    token_usage: dict | None = None,
    cost_cny: float = 0,
) -> None:
    """Update build metadata after ingest completes and activate it."""
    with connect() as conn:
        conn.execute(
            """
            UPDATE builds
            SET chunk_count = ?, segment_count = ?, tags_json = ?,
                token_usage_json = ?, estimated_cost_cny = ?, is_active = 1
            WHERE id = ?
            """,
            (
                chunk_count,
                segment_count,
                json.dumps(tags, ensure_ascii=False),
                json.dumps(token_usage or {}, ensure_ascii=False),
                cost_cny,
                build_id,
            ),
        )
        # Deactivate all others
        conn.execute("UPDATE builds SET is_active = 0 WHERE id != ?", (build_id,))
        conn.commit()


def get_active_build_id() -> str | None:
    """Return the active build ID, or None."""
    with connect() as conn:
        row = conn.execute(
            "SELECT id FROM builds WHERE is_active = 1 ORDER BY created_at DESC LIMIT 1"
        ).fetchone()
    return row["id"] if row else None


def list_builds() -> list[dict]:
    """List all builds, newest first."""
    with connect() as conn:
        rows = conn.execute(
            """
            SELECT id, source_file, chunk_count, segment_count, is_active,
                   token_usage_json, estimated_cost_cny, tags_json, created_at
            FROM builds ORDER BY created_at DESC
            """
        ).fetchall()
    return [
        {
            "id": r["id"],
            "source_file": r["source_file"],
            "chunk_count": r["chunk_count"],
            "segment_count": r["segment_count"],
            "is_active": bool(r["is_active"]),
            "token_usage": json.loads(r["token_usage_json"]) if r["token_usage_json"] else {},
            "estimated_cost_cny": r["estimated_cost_cny"],
            "tags": json.loads(r["tags_json"]) if r["tags_json"] else {},
            "created_at": r["created_at"],
        }
        for r in rows
    ]


def delete_build(build_id: str) -> None:
    """Delete a build and its tag_segments."""
    with connect() as conn:
        was_active = conn.execute(
            "SELECT is_active FROM builds WHERE id = ?", (build_id,)
        ).fetchone()
        conn.execute("DELETE FROM tag_segments WHERE build_id = ?", (build_id,))
        conn.execute("DELETE FROM builds WHERE id = ?", (build_id,))
        # If deleted build was active, activate the latest remaining
        if was_active and was_active["is_active"]:
            latest = conn.execute(
                "SELECT id FROM builds ORDER BY created_at DESC LIMIT 1"
            ).fetchone()
            if latest:
                conn.execute("UPDATE builds SET is_active = 1 WHERE id = ?", (latest["id"],))
        conn.commit()
