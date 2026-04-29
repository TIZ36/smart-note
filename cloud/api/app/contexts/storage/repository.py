"""Storage context — persistence.

Owns reads/writes to the `documents` table. Document CRUD still
lives inline in `app/routers/documents.py`; this module exposes the
focused read API other contexts (telemetry, console) call so they
don't have to touch the table directly.
"""

from __future__ import annotations

from dataclasses import dataclass
from uuid import UUID

from app.db import pool


@dataclass(frozen=True)
class DocumentCounts:
    """What `documents` looks like for one workspace, by smartnote_type.
    Used by the console aggregator. Total = notes + wiki_topics + others
    (`others` covers smart_table / raw text / future kinds)."""
    total: int
    notes: int
    wiki_topics: int
    others: int


async def count_for(workspace_id: str) -> DocumentCounts:
    async with pool().acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT
              count(*)                                              AS total,
              count(*) FILTER (WHERE metadata->>'smartnote_type' = 'note')        AS notes,
              count(*) FILTER (WHERE metadata->>'smartnote_type' = 'wiki_topic')  AS wiki_topics
            FROM documents
            WHERE workspace_id = $1
            """,
            UUID(workspace_id),
        )
    total = int(row["total"])
    notes = int(row["notes"])
    wiki = int(row["wiki_topics"])
    return DocumentCounts(
        total=total,
        notes=notes,
        wiki_topics=wiki,
        others=max(0, total - notes - wiki),
    )
