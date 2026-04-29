"""Knowledge context — persistence layer.

Owns reads/writes to: chunks, tag_segments, entities, entity_links,
wiki_nodes, and most of the memories table (everything except the
enrichment-owned `(kind=preference, content=enrich_provider)` slice).

Holds the SQL needed for event-driven cleanup and console-side
aggregation. The full search / retrieve / wiki SQL still lives in
`app.services.kb.*` and inline in `app.routers.*`; future passes
lift that here.
"""

from __future__ import annotations

from dataclasses import dataclass
from uuid import UUID

from app.db import pool


@dataclass(frozen=True)
class KnowledgeCounts:
    """One-workspace snapshot of knowledge inventory. Powers the Sync
    tab's "Cloud knowledge" strip + the console aggregator. Memory
    count excludes the enrichment-owned slice
    (`kind=preference AND content=enrich_provider`) so the number
    matches what the user sees as their semantic memory store."""
    memories: int
    proposals_pending: int
    chunks: int
    tag_segments: int
    distinct_tags: int
    wiki_nodes: int


async def count_for(workspace_id: str) -> KnowledgeCounts:
    """Single round-trip aggregate. Keeping it one query (instead of
    five) means the console snapshot stays cheap even when the
    workspace grows — Postgres parallel-aggregates the `count(*)`s."""
    ws = UUID(workspace_id)
    async with pool().acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT
              (SELECT count(*) FROM memories
                 WHERE workspace_id = $1
                   AND NOT (kind = 'preference' AND content = 'enrich_provider')
              )                                                            AS memories,
              (SELECT count(*) FROM memories
                 WHERE workspace_id = $1 AND status = 'draft')             AS proposals_pending,
              (SELECT count(*) FROM chunks       WHERE workspace_id = $1)  AS chunks,
              (SELECT count(*) FROM tag_segments WHERE workspace_id = $1)  AS tag_segments,
              (SELECT count(DISTINCT tag) FROM tag_segments
                 WHERE workspace_id = $1 AND tag IS NOT NULL)              AS distinct_tags,
              (SELECT count(*) FROM wiki_nodes   WHERE workspace_id = $1)  AS wiki_nodes
            """,
            ws,
        )
    return KnowledgeCounts(
        memories=int(row["memories"]),
        proposals_pending=int(row["proposals_pending"]),
        chunks=int(row["chunks"]),
        tag_segments=int(row["tag_segments"]),
        distinct_tags=int(row["distinct_tags"]),
        wiki_nodes=int(row["wiki_nodes"]),
    )


async def cleanup_document_refs(workspace_id: str, document_id: str) -> int:
    """Drop document_ref memories that point at a deleted document so
    the workspace doesn't accumulate orphans pointing at vanished
    docs. Returns the number of rows deleted.

    Storage no longer does this inline — it publishes
    `DocumentDeleted` and we react. FK CASCADE handles chunks /
    tag_segments / enrich_jobs; document_ref memories live in a
    JSONB-keyed structured column (no FK), so we clean them
    explicitly.
    """
    async with pool().acquire() as conn:
        result = await conn.execute(
            "DELETE FROM memories "
            "WHERE workspace_id = $1 "
            "  AND kind = 'document_ref' "
            "  AND structured->>'document_id' = $2",
            UUID(workspace_id), document_id,
        )
    # asyncpg returns a status string like "DELETE 3"; parse the count.
    try:
        return int(result.split()[-1])
    except (ValueError, IndexError):
        return 0
