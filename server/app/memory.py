"""Q&A Memory system.

Stores full Q&A snapshots with search parameters on user upvote.
Retrieves them by query embedding similarity for two use cases:
  1. Similar question (sim > 0.7) → reference stored params/weights
  2. Near-identical question (sim > 0.85) → reference stored answer (scored, not blind)
"""

from __future__ import annotations

import json
import math

from app.db import connect
from app.embed import embed_texts


def _cosine(a: list[float], b: list[float]) -> float:
    if not a or not b:
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)


def add_feedback(answer_id: int, feedback_type: str) -> None:
    """Record feedback in feedback_logs."""
    with connect() as conn:
        conn.execute(
            "INSERT INTO feedback_logs(answer_id, feedback_type) VALUES(?, ?)",
            (answer_id, feedback_type),
        )
        conn.commit()


def save_qa_memory(
    query: str,
    answer: str,
    evidence_ids: list[int],
    weights: dict[str, float] | None = None,
) -> int:
    """Save a Q&A pair as memory (called on user upvote)."""
    qv = embed_texts([query])[0]

    with connect() as conn:
        # Check if a near-identical query memory already exists
        existing = conn.execute(
            "SELECT id, feedback_score, query_embedding_json FROM qa_memories"
        ).fetchall()

        for row in existing:
            emb = row["query_embedding_json"]
            if emb:
                sim = _cosine(qv, json.loads(emb))
                if sim > 0.9:
                    # Update existing memory — strengthen it
                    conn.execute(
                        """
                        UPDATE qa_memories
                        SET feedback_score = feedback_score + 1.0,
                            answer_text = ?,
                            evidence_ids_json = ?,
                            weights_json = ?,
                            updated_at = CURRENT_TIMESTAMP
                        WHERE id = ?
                        """,
                        (
                            answer,
                            json.dumps(evidence_ids),
                            json.dumps(weights or {}),
                            row["id"],
                        ),
                    )
                    conn.commit()
                    return row["id"]

        # New memory
        conn.execute(
            """
            INSERT INTO qa_memories(query_text, query_embedding_json, answer_text,
                evidence_ids_json, weights_json)
            VALUES (?, ?, ?, ?, ?)
            """,
            (
                query,
                json.dumps(qv),
                answer,
                json.dumps(evidence_ids),
                json.dumps(weights or {}),
            ),
        )
        conn.commit()
        return conn.execute("SELECT last_insert_rowid()").fetchone()[0]


def recall_qa_memories(query: str) -> dict:
    """Find relevant Q&A memories for a query.

    Returns:
        {
            "params": {...weights...} or None  — if similar question found (sim > 0.7)
            "answer_hits": [...]               — near-identical questions with answers (sim > 0.85)
        }
    """
    qv = embed_texts([query])[0]

    with connect() as conn:
        rows = conn.execute(
            "SELECT id, query_text, query_embedding_json, answer_text, "
            "evidence_ids_json, weights_json, feedback_score, used_count "
            "FROM qa_memories"
        ).fetchall()

    param_ref: dict | None = None
    answer_hits: list[dict] = []
    best_param_sim = 0.0

    for row in rows:
        emb = row["query_embedding_json"]
        if not emb:
            continue
        sim = _cosine(qv, json.loads(emb))

        # Tier 1: Similar question (sim > 0.7) → reference params
        if sim > 0.7 and sim > best_param_sim:
            best_param_sim = sim
            weights = json.loads(row["weights_json"]) if row["weights_json"] else None
            if weights:
                param_ref = {
                    "weights": weights,
                    "similarity": sim,
                    "source_query": row["query_text"],
                }

        # Tier 2: Near-identical (sim > 0.85) → reference answer
        if sim > 0.85:
            answer_hits.append({
                "id": f"qa_memory:{row['id']}",
                "text": row["answer_text"],
                "source_ref": f"qa_memory:{row['query_text'][:40]}",
                "dimension": "qa_memory",
                "score": sim * row["feedback_score"],
                "similarity": sim,
                "original_query": row["query_text"],
            })

            # Track usage
            with connect() as conn2:
                conn2.execute(
                    "UPDATE qa_memories SET used_count = used_count + 1 WHERE id = ?",
                    (row["id"],),
                )
                conn2.commit()

    # Sort answer hits by score
    answer_hits.sort(key=lambda x: x["score"], reverse=True)

    return {
        "params": param_ref,
        "answer_hits": answer_hits[:3],  # Top 3 at most
    }
