"""Knowledge graph queries — entities, tags, and their connections."""

from __future__ import annotations

import json

from app.db import connect


def get_graph() -> dict:
    """Return nodes, edges, tag-entity links, and stats."""
    with connect() as conn:
        nodes = conn.execute(
            "SELECT id, name, entity_type, mention_count FROM entities ORDER BY mention_count DESC"
        ).fetchall()

        edges = conn.execute(
            """
            SELECT el.source_entity_id, el.target_entity_id, el.relation, el.weight,
                   e1.name as source_name, e2.name as target_name
            FROM entity_links el
            JOIN entities e1 ON e1.id = el.source_entity_id
            JOIN entities e2 ON e2.id = el.target_entity_id
            ORDER BY el.weight DESC
            """
        ).fetchall()

        # Tag-entity links: which entities appear under which tags
        tag_entity_rows = conn.execute(
            """
            SELECT ts.tag, ts.entities_json
            FROM tag_segments ts
            WHERE ts.entities_json != '[]'
            """
        ).fetchall()

        tag_entities: dict[str, dict[str, int]] = {}
        for row in tag_entity_rows:
            tag = row["tag"]
            if tag not in tag_entities:
                tag_entities[tag] = {}
            try:
                ents = json.loads(row["entities_json"])
                for ent in ents:
                    name = ent.get("name", "")
                    if name:
                        tag_entities[tag][name] = tag_entities[tag].get(name, 0) + 1
            except (json.JSONDecodeError, TypeError):
                pass

        # Stats
        chunk_count = conn.execute("SELECT COUNT(1) c FROM chunks").fetchone()["c"]
        tag_counts = conn.execute(
            "SELECT tag, COUNT(1) c, SUM(line_end - line_start + 1) lines FROM tag_segments GROUP BY tag"
        ).fetchall()
        memory_count = 0
        try:
            memory_count = conn.execute("SELECT COUNT(1) c FROM qa_memories").fetchone()["c"]
        except Exception:
            pass
        feedback_count = conn.execute("SELECT COUNT(1) c FROM feedback_logs").fetchone()["c"]

    return {
        "nodes": [
            {"id": n["id"], "name": n["name"], "type": n["entity_type"], "mentions": n["mention_count"]}
            for n in nodes
        ],
        "edges": [
            {"source": e["source_entity_id"], "target": e["target_entity_id"], "relation": e["relation"], "weight": e["weight"]}
            for e in edges
        ],
        "tag_entities": {
            tag: [{"name": name, "count": count} for name, count in sorted(ents.items(), key=lambda x: -x[1])[:20]]
            for tag, ents in tag_entities.items()
        },
        "stats": {
            "total_chunks": chunk_count,
            "total_entities": len(nodes),
            "total_memories": memory_count,
            "total_feedback": feedback_count,
            "tags": {r["tag"]: {"segments": r["c"], "lines": r["lines"]} for r in tag_counts},
        },
    }
