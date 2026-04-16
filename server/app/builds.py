"""Build management — each build is a tag classification snapshot with its own tag config."""

from __future__ import annotations

import json
from datetime import datetime

from app.db import connect


def create_build(source_file: str) -> str:
    """Create a new build, snapshot current tag config, return build ID."""
    from app.tags import get_tags_with_desc

    build_id = datetime.now().strftime("%Y%m%d_%H%M%S")
    tags_config = get_tags_with_desc()

    with connect() as conn:
        conn.execute(
            "INSERT INTO builds(id, source_file, tags_config_json) VALUES(?, ?, ?)",
            (build_id, source_file, json.dumps(tags_config, ensure_ascii=False)),
        )
        conn.commit()
    return build_id


def activate_build(build_id: str) -> None:
    """Activate a build — switches tag config + tag segments."""
    from app.tags import _save_tags

    with connect() as conn:
        # Load the build's tag config
        row = conn.execute(
            "SELECT tags_config_json FROM builds WHERE id = ?", (build_id,)
        ).fetchone()

        conn.execute("UPDATE builds SET is_active = 0")
        conn.execute("UPDATE builds SET is_active = 1 WHERE id = ?", (build_id,))
        conn.commit()

    # Restore the tag config from this build
    if row and row["tags_config_json"]:
        try:
            saved_tags = json.loads(row["tags_config_json"])
            if isinstance(saved_tags, list) and len(saved_tags) > 0:
                _save_tags(saved_tags)
        except (json.JSONDecodeError, TypeError):
            pass


def finalize_build(
    build_id: str,
    chunk_count: int,
    segment_count: int,
    tags: dict[str, int],
    token_usage: dict | None = None,
    cost_cny: float = 0,
    enrich_status: str = "completed",
    completed_by: str = "",
) -> None:
    """Update build metadata after ingest completes and activate it.

    enrich_status: one of 'completed', 'awaiting_enrich', 'partial'. Set to
    'awaiting_enrich' when ingest ran in delegate mode — Claude (or another
    MCP caller) is expected to fill in classifications/summaries, which will
    flip the status back to 'completed'.

    completed_by: who produced the enrichment. Empty when still awaiting.
    'provider:<model>' when backend LLM enriched; 'mcp:delegate' when an MCP
    caller (e.g. Claude) submitted enrichments via /enrich-bulk; 'fallback'
    when AI was disabled and the lone 'others' placeholder was used.
    """
    from app.tags import get_tags_with_desc

    tags_config = get_tags_with_desc()

    with connect() as conn:
        # awaiting_since is set the moment status flips to awaiting_enrich
        # and cleared on completion — powers the stuck-pending guard.
        if enrich_status == "awaiting_enrich":
            awaiting_sql = "awaiting_since = COALESCE(awaiting_since, CURRENT_TIMESTAMP)"
        else:
            awaiting_sql = "awaiting_since = NULL"
        conn.execute(
            f"""
            UPDATE builds
            SET chunk_count = ?, segment_count = ?, tags_json = ?,
                token_usage_json = ?, estimated_cost_cny = ?,
                tags_config_json = ?, enrich_status = ?,
                completed_by = ?, is_active = 1,
                {awaiting_sql}
            WHERE id = ?
            """,
            (
                chunk_count,
                segment_count,
                json.dumps(tags, ensure_ascii=False),
                json.dumps(token_usage or {}, ensure_ascii=False),
                cost_cny,
                json.dumps(tags_config, ensure_ascii=False),
                enrich_status,
                completed_by,
                build_id,
            ),
        )
        conn.execute("UPDATE builds SET is_active = 0 WHERE id != ?", (build_id,))
        conn.commit()


def recompute_enrich_status(build_id: str) -> str:
    """Recompute the enrich_status of a build based on pending signals.

    Also refreshes `segment_count` and flips `completed_by` to 'mcp:delegate'
    if the build is now complete and no attribution had been recorded.
    Returns the new status: 'completed' if nothing pending, 'awaiting_enrich'
    otherwise.
    """
    with connect() as conn:
        build_row = conn.execute(
            "SELECT source_file, completed_by FROM builds WHERE id = ?", (build_id,)
        ).fetchone()
        if not build_row:
            return "completed"
        is_wiki = (build_row["source_file"] or "").startswith("wiki:")
        prior_completed_by = build_row["completed_by"] or ""

        pending = 0
        if is_wiki:
            r = conn.execute(
                "SELECT COUNT(1) c FROM chunks WHERE build_id = ? AND ai_summary = ''",
                (build_id,),
            ).fetchone()
            pending += int(r["c"] or 0)
            r = conn.execute(
                "SELECT COUNT(1) c FROM tag_segments WHERE build_id = ? AND summary = ''",
                (build_id,),
            ).fetchone()
            pending += int(r["c"] or 0)
        else:
            r = conn.execute(
                "SELECT COUNT(1) c FROM chunks WHERE build_id = ? AND (dimension = '' OR dimension IS NULL)",
                (build_id,),
            ).fetchone()
            pending += int(r["c"] or 0)

        # Also sync segment_count from tag_segments — /enrich-bulk inserts
        # rows directly and this keeps the build row in sync.
        seg_row = conn.execute(
            "SELECT COUNT(1) c FROM tag_segments WHERE build_id = ?", (build_id,)
        ).fetchone()
        segment_count = int(seg_row["c"] or 0)

        status = "completed" if pending == 0 else "awaiting_enrich"

        # Attribution: if the build had no prior attribution (or was marked as
        # awaiting) and now something has been filled in, credit the MCP caller.
        new_completed_by = prior_completed_by
        if status == "completed" and not prior_completed_by:
            new_completed_by = "mcp:delegate"

        # Clear / set awaiting_since alongside status
        awaiting_sql = (
            "awaiting_since = COALESCE(awaiting_since, CURRENT_TIMESTAMP)"
            if status == "awaiting_enrich"
            else "awaiting_since = NULL"
        )
        conn.execute(
            f"UPDATE builds SET enrich_status = ?, segment_count = ?, "
            f"completed_by = ?, {awaiting_sql} WHERE id = ?",
            (status, segment_count, new_completed_by, build_id),
        )
        conn.commit()
        return status


def get_active_build_id() -> str | None:
    with connect() as conn:
        row = conn.execute(
            "SELECT id FROM builds WHERE is_active = 1 ORDER BY created_at DESC LIMIT 1"
        ).fetchone()
    return row["id"] if row else None


def list_builds(include_wiki: bool = False) -> list[dict]:
    with connect() as conn:
        query = """
            SELECT id, source_file, chunk_count, segment_count, is_active,
                   token_usage_json, estimated_cost_cny, tags_json,
                   enrich_status, completed_by, awaiting_since,
                   CASE WHEN awaiting_since IS NULL THEN NULL
                        ELSE CAST(
                          (julianday('now') - julianday(awaiting_since)) * 86400
                          AS INTEGER) END AS awaiting_for_seconds,
                   created_at
            FROM builds
        """
        if not include_wiki:
            query += " WHERE source_file NOT LIKE 'wiki:%'"
        query += " ORDER BY created_at DESC"
        rows = conn.execute(query).fetchall()
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
            "enrich_status": r["enrich_status"] if "enrich_status" in r.keys() else "completed",
            "completed_by": r["completed_by"] if "completed_by" in r.keys() else "",
            "awaiting_since": r["awaiting_since"] if "awaiting_since" in r.keys() else None,
            "awaiting_for_seconds": r["awaiting_for_seconds"] if "awaiting_for_seconds" in r.keys() else None,
            "created_at": r["created_at"],
        }
        for r in rows
    ]


def delete_build(build_id: str) -> None:
    with connect() as conn:
        row = conn.execute(
            "SELECT is_active, source_file FROM builds WHERE id = ?", (build_id,)
        ).fetchone()
        if not row:
            return
        # Prevent accidental deletion of wiki builds via general endpoint
        if row["source_file"] and row["source_file"].startswith("wiki:"):
            return
        conn.execute("DELETE FROM chunks WHERE build_id = ?", (build_id,))
        conn.execute("DELETE FROM tag_segments WHERE build_id = ?", (build_id,))
        conn.execute("DELETE FROM builds WHERE id = ?", (build_id,))
        if row["is_active"]:
            latest = conn.execute(
                "SELECT id FROM builds WHERE source_file NOT LIKE 'wiki:%' ORDER BY created_at DESC LIMIT 1"
            ).fetchone()
            if latest:
                conn.execute("UPDATE builds SET is_active = 1 WHERE id = ?", (latest["id"],))
        conn.commit()

    # If deleted was active, restore the new active build's tag config
    if row and row["is_active"]:
        new_active = get_active_build_id()
        if new_active:
            activate_build(new_active)
