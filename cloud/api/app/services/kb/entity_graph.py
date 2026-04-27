"""Entity graph — extract from classifier output, render as graph.

The enrich classifier returns segments shaped like
  { tag, line_start, line_end, summary, keywords, entities: [{name, type}] }
We persist those entities into `entities` (one row per workspace +
distinct name), build co-occurrence edges in `entity_links` for
entities that landed in the same segment, and stamp tag_entities so
the wiki-graph view can group by topic.

Idempotent: re-ingesting a document re-runs upsert_entities_for_doc,
which deletes prior entity_links + tag_entities rows that came from
this document's segments before re-inserting. (Mention counts on
`entities` keep climbing — they're cross-document totals by design.)
"""

from __future__ import annotations

import logging
from typing import Iterable
from uuid import UUID

log = logging.getLogger(__name__)


async def upsert_entities_for_segments(
    conn,
    workspace_id: str,
    segments: list[dict],
) -> dict:
    """Persist entities + co-occurrence edges + tag_entities from one
    enrich pass over a document. Caller wraps in a transaction.

    Returns: { entities: N, links: N, tag_entities: N }
    """
    ws = UUID(workspace_id)
    new_entities = updated_entities = links = tag_links = 0

    for seg in segments:
        tag = (seg.get("tag") or "").strip()
        seg_entity_ids: list[UUID] = []
        for ent in seg.get("entities") or []:
            if not isinstance(ent, dict):
                continue
            name = (ent.get("name") or "").strip()
            etype = (ent.get("type") or "concept").strip() or "concept"
            if not name or len(name) > 200:
                continue

            row = await conn.fetchrow(
                """
                INSERT INTO entities (workspace_id, name, entity_type)
                VALUES ($1, $2, $3)
                ON CONFLICT (workspace_id, name) DO UPDATE
                  SET mention_count = entities.mention_count + 1,
                      last_seen = now()
                RETURNING id, (xmax = 0) AS inserted
                """,
                ws, name, etype,
            )
            if row["inserted"]:
                new_entities += 1
            else:
                updated_entities += 1
            seg_entity_ids.append(row["id"])

            # tag_entity edge — bumps count if (workspace, tag, entity) seen again.
            if tag:
                await conn.execute(
                    """
                    INSERT INTO tag_entities (workspace_id, tag, entity_id)
                    VALUES ($1, $2, $3)
                    ON CONFLICT (workspace_id, tag, entity_id) DO UPDATE
                      SET count = tag_entities.count + 1
                    """,
                    ws, tag, row["id"],
                )
                tag_links += 1

        # Co-occurrence edges within this segment. Canonicalize ordering
        # (smaller uuid → source) so (a→b) and (b→a) collapse onto the
        # unique index.
        for i, a in enumerate(seg_entity_ids):
            for b in seg_entity_ids[i + 1:]:
                if a == b:
                    continue
                src, dst = (a, b) if str(a) < str(b) else (b, a)
                await conn.execute(
                    """
                    INSERT INTO entity_links
                      (workspace_id, source_entity_id, target_entity_id, relation)
                    VALUES ($1, $2, $3, 'co-occurs')
                    ON CONFLICT (workspace_id, source_entity_id, target_entity_id, relation)
                    DO UPDATE SET weight = entity_links.weight + 1
                    """,
                    ws, src, dst,
                )
                links += 1
    return {
        "entities_new": new_entities,
        "entities_updated": updated_entities,
        "links": links,
        "tag_entities": tag_links,
    }


async def get_graph(conn, workspace_id: str, *, top_n: int = 200) -> dict:
    """Return entity graph for the workspace's WikiGraph / KnowledgeGraph
    panels. Caps node count at top_n by mention to keep the renderer
    responsive on large workspaces."""
    ws = UUID(workspace_id)
    nodes_rows = await conn.fetch(
        "SELECT id, name, entity_type, mention_count FROM entities "
        "WHERE workspace_id = $1 ORDER BY mention_count DESC LIMIT $2",
        ws, top_n,
    )
    keep_ids = {str(r["id"]) for r in nodes_rows}

    edges_rows = await conn.fetch(
        """
        SELECT el.source_entity_id, el.target_entity_id, el.relation, el.weight,
               s.name AS source_name, t.name AS target_name
        FROM entity_links el
        JOIN entities s ON s.id = el.source_entity_id
        JOIN entities t ON t.id = el.target_entity_id
        WHERE el.workspace_id = $1
        ORDER BY el.weight DESC
        LIMIT $2
        """,
        ws, top_n * 4,
    )

    tag_rows = await conn.fetch(
        """
        SELECT te.tag, te.count, e.id, e.name, e.mention_count
        FROM tag_entities te
        JOIN entities e ON e.id = te.entity_id
        WHERE te.workspace_id = $1
        ORDER BY te.count DESC
        """,
        ws,
    )
    tag_entities: dict[str, list[dict]] = {}
    for r in tag_rows:
        if str(r["id"]) not in keep_ids:
            continue
        tag_entities.setdefault(r["tag"], []).append({
            "name": r["name"],
            "count": int(r["count"]),
            "mention_count": int(r["mention_count"]),
        })

    counts = await conn.fetchrow(
        """
        SELECT
          (SELECT count(*) FROM chunks WHERE workspace_id=$1)        AS total_chunks,
          (SELECT count(*) FROM entities WHERE workspace_id=$1)      AS total_entities,
          (SELECT count(*) FROM memories WHERE workspace_id=$1)      AS total_memories
        """,
        ws,
    )

    return {
        "nodes": [
            {"id": str(r["id"]), "name": r["name"], "type": r["entity_type"],
             "mentions": int(r["mention_count"])}
            for r in nodes_rows
        ],
        "edges": [
            {
                "source": str(r["source_entity_id"]),
                "target": str(r["target_entity_id"]),
                "source_name": r["source_name"],
                "target_name": r["target_name"],
                "relation": r["relation"],
                "weight": int(r["weight"]),
            }
            for r in edges_rows
            if str(r["source_entity_id"]) in keep_ids
            and str(r["target_entity_id"]) in keep_ids
        ],
        "tag_entities": tag_entities,
        "stats": {
            "total_chunks": int(counts["total_chunks"] or 0),
            "total_entities": int(counts["total_entities"] or 0),
            "total_memories": int(counts["total_memories"] or 0),
            "total_feedback": 0,  # parity with local shape; not persisted cloud-side yet
            "tags": {},  # filled below
        },
    }
