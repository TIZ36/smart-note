from __future__ import annotations

import hashlib

import requests

from app.config import settings


def _embed_local(texts: list[str]) -> list[list[float]]:
    resp = requests.post(
        settings.local_embed_endpoint, json={"texts": texts}, timeout=30
    )
    resp.raise_for_status()
    data = resp.json()
    return data["vectors"]


def _embed_api(texts: list[str]) -> list[list[float]]:
    # Use separate embedding provider if configured, else fall back to chat provider
    headers = {
        "Authorization": f"Bearer {settings.effective_embed_api_key}",
        "Content-Type": "application/json",
    }
    url = f"{settings.effective_embed_base_url.rstrip('/')}/embeddings"
    payload = {"model": settings.provider_embed_model, "input": texts}
    resp = requests.post(url, headers=headers, json=payload, timeout=30)
    resp.raise_for_status()
    data = resp.json()
    return [item["embedding"] for item in data["data"]]


def _embed_mock(texts: list[str], dims: int = 128) -> list[list[float]]:
    vectors: list[list[float]] = []
    for text in texts:
        digest = hashlib.sha256(text.encode("utf-8")).digest()
        vals = []
        for i in range(dims):
            b = digest[i % len(digest)]
            vals.append((b / 255.0) * 2.0 - 1.0)
        vectors.append(vals)
    return vectors


def embed_texts(texts: list[str]) -> list[list[float]]:
    if settings.embedding_mode == "mock":
        return _embed_mock(texts)
    if settings.embedding_mode == "local":
        try:
            return _embed_local(texts)
        except Exception:
            return _embed_mock(texts)
    return _embed_api(texts)
