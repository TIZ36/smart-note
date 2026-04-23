"""Thin client for the self-hosted embedding service.

Graceful-degradation policy: if the embed service is unreachable (dev
machine without Docker up, local network blip), memory writes still
succeed — they just land with `embedding = NULL`. A background
re-embedding pass (v1.1) will fill them in later. Blocking writes on
embedding availability would make the service look broken when the
issue is actually transient.
"""

from __future__ import annotations

import logging

import httpx

from app.config import get_settings

logger = logging.getLogger(__name__)


async def embed_texts(texts: list[str]) -> list[list[float] | None]:
    """Embed a batch. Returns one vector per input, or None for any input
    the embed service refused to process (shouldn't happen in practice,
    but preserving the slot keeps caller indexing simple)."""
    if not texts:
        return []
    cfg = get_settings()
    try:
        async with httpx.AsyncClient(timeout=cfg.embed_timeout_sec) as client:
            resp = await client.post(
                f"{cfg.embed_url}/embed",
                json={"texts": texts},
            )
            resp.raise_for_status()
            data = resp.json()
            vectors = data.get("vectors") or []
            if len(vectors) != len(texts):
                logger.warning(
                    "embed service returned %d vectors for %d inputs",
                    len(vectors), len(texts),
                )
            # Normalize length to match input so callers can zip safely.
            return list(vectors) + [None] * max(0, len(texts) - len(vectors))
    except (httpx.HTTPError, httpx.TimeoutException) as e:
        logger.warning("embed service unreachable: %s — writing without embeddings", e)
        return [None] * len(texts)


async def embed_one(text: str) -> list[float] | None:
    return (await embed_texts([text]))[0]


def format_vector_literal(vec: list[float]) -> str:
    """asyncpg doesn't natively encode pgvector; the simplest portable
    path is to pass the canonical `[f1, f2, ...]` text literal and let
    Postgres parse it. Reasonably fast for 384-dim vectors."""
    return "[" + ",".join(f"{f:.6f}" for f in vec) + "]"
