"""Adaptive search weights — learns from successful query profiles.

When a user upvotes an answer, the system saves the full query execution profile
(which retrieval paths contributed, what weights produced good results).
For future similar queries, it adjusts weights based on past successes.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass

from app.db import connect
from app.embed import embed_texts


DEFAULT_WEIGHTS = {
    "fts": 0.18,
    "sub": 0.17,
    "ngram": 0.08,
    "vec": 0.22,
    "kw": 0.12,
    "tag_meta": 0.15,
    "mem": 0.03,
    "feedback_bias": 0.05,
}


@dataclass
class QueryProfile:
    query_text: str
    weights: dict[str, float]
    evidence_ids: list[int]
    rerank_order: list[int] | None = None
    feedback_score: float = 0.0


def _cosine(a: list[float], b: list[float]) -> float:
    if not a or not b:
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)


def get_adaptive_weights(query: str) -> dict[str, float]:
    """Find similar past successful queries and blend their weights.

    Returns adjusted weights if similar profiles exist, else default weights.
    """
    with connect() as conn:
        profiles = conn.execute(
            """
            SELECT query_text, query_embedding_json, effective_weights_json,
                   feedback_score, hit_count
            FROM query_profiles
            WHERE feedback_score > 0
            ORDER BY feedback_score DESC, hit_count DESC
            LIMIT 50
            """
        ).fetchall()

    if not profiles:
        return dict(DEFAULT_WEIGHTS)

    # Embed the current query
    qv = embed_texts([query])[0]

    # Find similar past queries by embedding similarity
    similar: list[tuple[float, dict]] = []
    for p in profiles:
        p_emb = p["query_embedding_json"]
        if not p_emb:
            continue
        sim = _cosine(qv, json.loads(p_emb))
        if sim > 0.6:  # Only consider reasonably similar queries
            weights = json.loads(p["effective_weights_json"])
            score = p["feedback_score"]
            similar.append((sim * score, weights))

    if not similar:
        return dict(DEFAULT_WEIGHTS)

    # Weighted average of similar profile weights, blended with defaults
    total_weight = sum(s for s, _ in similar)
    blended = dict(DEFAULT_WEIGHTS)

    if total_weight > 0:
        for key in blended:
            learned = sum(s * w.get(key, 0) for s, w in similar) / total_weight
            # 70% learned, 30% default — don't stray too far
            blended[key] = 0.7 * learned + 0.3 * DEFAULT_WEIGHTS.get(key, 0)

        # Normalize to sum to ~1.0
        total = sum(blended.values())
        if total > 0:
            for key in blended:
                blended[key] /= total

    return blended


def save_query_profile(
    query: str,
    weights: dict[str, float],
    evidence_ids: list[int],
    rerank_order: list[int] | None = None,
) -> int:
    """Save a query execution profile for future learning."""
    qv = embed_texts([query])[0]

    with connect() as conn:
        # Check if a similar profile already exists
        existing = conn.execute(
            "SELECT id, hit_count FROM query_profiles WHERE query_text = ?",
            (query,),
        ).fetchone()

        if existing:
            conn.execute(
                """
                UPDATE query_profiles
                SET hit_count = hit_count + 1,
                    effective_weights_json = ?,
                    evidence_ids_json = ?,
                    rerank_order_json = ?,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                """,
                (
                    json.dumps(weights),
                    json.dumps(evidence_ids),
                    json.dumps(rerank_order) if rerank_order else None,
                    existing["id"],
                ),
            )
            conn.commit()
            return existing["id"]
        else:
            conn.execute(
                """
                INSERT INTO query_profiles(
                    query_text, query_embedding_json, effective_weights_json,
                    evidence_ids_json, rerank_order_json
                ) VALUES (?, ?, ?, ?, ?)
                """,
                (
                    query,
                    json.dumps(qv),
                    json.dumps(weights),
                    json.dumps(evidence_ids),
                    json.dumps(rerank_order) if rerank_order else None,
                ),
            )
            conn.commit()
            pid = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
            return pid


def strengthen_profile(query: str, boost: float = 1.0) -> None:
    """Increase feedback_score for a query profile (called on upvote)."""
    with connect() as conn:
        conn.execute(
            """
            UPDATE query_profiles
            SET feedback_score = feedback_score + ?,
                updated_at = CURRENT_TIMESTAMP
            WHERE query_text = ?
            """,
            (boost, query),
        )
        conn.commit()
