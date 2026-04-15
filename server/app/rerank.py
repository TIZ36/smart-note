"""Stage 2: Rerank recall results using embedding cross-similarity + LLM scoring.

Takes raw recall hits and re-scores them for relevance to the query.
"""

from __future__ import annotations

import json
import logging
import math

import requests

from app.config import settings
from app.db import connect
from app.embed import embed_texts

logger = logging.getLogger(__name__)


def _cosine(a: list[float], b: list[float]) -> float:
    if not a or not b:
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)


def rerank(query: str, chunk_ids: list[int], use_llm: bool = False, topk: int = 5) -> dict:
    """Rerank chunks by embedding similarity. Loads embeddings from DB by ID.

    This avoids re-embedding the query — we embed once and reuse.
    """
    import time
    start = time.time()

    if not chunk_ids:
        return {"results": [], "latency_ms": 0}

    # Embed query once
    qv = embed_texts([query])[0]

    # Load chunk embeddings from DB
    with connect() as conn:
        placeholders = ",".join("?" for _ in chunk_ids)
        rows = conn.execute(
            f"""SELECT id, text, source_ref, dimension, embedding_json,
                       keywords_json, ai_summary
                FROM chunks WHERE id IN ({placeholders})""",
            chunk_ids,
        ).fetchall()

    # Score each chunk
    results = []
    for row in rows:
        emb = None
        if row["embedding_json"]:
            try:
                emb = json.loads(row["embedding_json"])
            except (json.JSONDecodeError, TypeError):
                pass

        vec_score = _cosine(qv, emb) if emb else 0.0

        results.append({
            "id": row["id"],
            "text": row["text"],
            "source_ref": row["source_ref"],
            "dimension": row["dimension"],
            "score": vec_score,  # recall score
            "rerank_score": vec_score,  # will be overridden by LLM if used
            "is_wiki": row["dimension"].startswith("wiki:") if row["dimension"] else False,
        })

    # Optionally use LLM for higher-quality scoring
    if use_llm and settings.provider_api_key and len(results) > 1:
        llm_results = _llm_rerank(query, results, topk)
        if llm_results:
            latency = int((time.time() - start) * 1000)
            return {"results": llm_results, "latency_ms": latency}

    results.sort(key=lambda x: x["rerank_score"], reverse=True)
    latency = int((time.time() - start) * 1000)
    return {"results": results[:topk], "latency_ms": latency}


def _llm_rerank(query: str, results: list[dict], topk: int) -> list[dict] | None:
    """Use LLM to score relevance. Returns None on failure."""
    entries = []
    for i, r in enumerate(results[:20]):
        entries.append(f"[{i + 1}] {r['text'][:200]}")

    prompt = f"""Given the query: "{query}"

Rate the relevance of each text snippet on a scale of 0-10.
Return ONLY a JSON array of numbers, one score per snippet, in order.
Example: [8, 3, 9, 1, 5]

Snippets:
{chr(10).join(entries)}"""

    try:
        base_url = settings.provider_base_url.rstrip("/")
        model = getattr(settings, "ingest_ai_model", None) or settings.provider_chat_model
        resp = requests.post(
            f"{base_url}/chat/completions",
            headers={
                "Authorization": f"Bearer {settings.provider_api_key}",
                "Content-Type": "application/json",
            },
            json={
                "model": model,
                "messages": [
                    {"role": "system", "content": "You are a relevance scoring assistant. Return only JSON."},
                    {"role": "user", "content": prompt},
                ],
                "temperature": 0.0,
            },
            timeout=15,
        )
        resp.raise_for_status()
        raw = resp.json()["choices"][0]["message"]["content"].strip()

        if raw.startswith("```"):
            raw = raw.split("\n", 1)[1].rsplit("```", 1)[0].strip()
        scores = json.loads(raw)

        if isinstance(scores, list):
            for i, score in enumerate(scores):
                if i < len(results):
                    # Clamp to [0, 10] and normalize to [0, 1]
                    clamped = max(0.0, min(10.0, float(score)))
                    results[i]["rerank_score"] = clamped / 10.0
            results.sort(key=lambda x: x.get("rerank_score", 0), reverse=True)
            return results[:topk]
    except Exception as e:
        logger.warning("LLM rerank failed: %s", e)

    return None
