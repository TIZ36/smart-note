"""Stage 2: Rerank recall results using embedding cross-similarity + LLM scoring.

Takes raw recall hits and re-scores them for relevance to the query.
"""

from __future__ import annotations

import json
import logging
import math

import requests

from app.config import settings
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


def rerank(query: str, results: list[dict], topk: int = 5) -> list[dict]:
    """Rerank results using embedding similarity.

    Computes fresh query-vs-chunk embedding similarity for precise ranking,
    rather than relying on the broad recall-stage scoring.
    """
    if not results:
        return []

    # Get query embedding
    qv = embed_texts([query])[0]

    # Re-score each result
    for item in results:
        # Embedding similarity (direct, more precise than recall-stage)
        emb = None
        if "embedding_json" in item and item["embedding_json"]:
            emb = json.loads(item["embedding_json"])
        elif "_embedding" in item:
            emb = item["_embedding"]

        vec_score = _cosine(qv, emb) if emb else item.get("vec", 0.0)

        # Combine: embedding similarity is primary, recall score is secondary
        recall_score = item.get("score", 0.0)
        item["rerank_score"] = 0.6 * vec_score + 0.4 * recall_score

    results.sort(key=lambda x: x.get("rerank_score", 0), reverse=True)
    return results[:topk]


def rerank_with_llm(query: str, results: list[dict], topk: int = 5) -> list[dict]:
    """Rerank using LLM to score relevance (higher quality, slower).

    Only used when provider is configured. Falls back to embedding rerank.
    """
    if not settings.provider_api_key or not results:
        return rerank(query, results, topk)

    # Build prompt for LLM scoring
    entries = []
    for i, r in enumerate(results[:20]):  # Cap at 20 to save tokens
        entries.append(f"[{i+1}] {r['text'][:200]}")

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

        # Parse scores
        if raw.startswith("```"):
            raw = raw.split("\n", 1)[1].rsplit("```", 1)[0].strip()
        scores = json.loads(raw)

        if isinstance(scores, list):
            for i, score in enumerate(scores):
                if i < len(results):
                    results[i]["rerank_score"] = float(score) / 10.0
            results.sort(key=lambda x: x.get("rerank_score", 0), reverse=True)
            return results[:topk]
    except Exception as e:
        logger.warning("LLM rerank failed, falling back to embedding: %s", e)

    return rerank(query, results, topk)
