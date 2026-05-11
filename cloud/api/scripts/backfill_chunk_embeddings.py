"""Backfill chunks.embedding from chunk_blobs for chunks that landed
with embedding=NULL because the wiki ingest path skipped re-embedding
on chunk_blobs cache hits without copying the cached vector into the
chunks row.

Idempotent — only touches `chunks` rows where embedding IS NULL.

Usage:
  DATABASE_URL=postgresql://... python -m scripts.backfill_chunk_embeddings

Match: chunks.text → canonicalize() → sha256 → chunk_blobs.content_sha.
We compute canonical_sha in Python (not SQL) because canonicalize is
non-trivial (CRLF strip + inline-WS collapse). Embedding text is
copied byte-for-byte; both columns are the same pgvector dimension.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import re
import sys

import asyncpg

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s: %(message)s")
log = logging.getLogger("backfill_chunk_embeddings")


def canonicalize(text: str) -> str:
    """Mirror of `app.infra.canonical.canonicalize`. Keep byte-identical."""
    if not text:
        return ""
    if text.startswith("﻿"):
        text = text[1:]
    text = text.replace("\r\n", "\n").replace("\r", "\n").strip()
    text = "\n".join(line.rstrip(" \t") for line in text.split("\n"))
    return re.sub(r"[ \t]+", " ", text)


def canonical_sha(text: str) -> str:
    return hashlib.sha256(canonicalize(text).encode("utf-8")).hexdigest()


async def main() -> int:
    url = os.environ.get("DATABASE_URL")
    if not url:
        log.error("DATABASE_URL is required")
        return 2
    conn = await asyncpg.connect(url)
    try:
        rows = await conn.fetch(
            "SELECT id, workspace_id, text FROM chunks WHERE embedding IS NULL"
        )
        log.info("scanning %d NULL-embedding chunks", len(rows))
        fixed = 0
        for r in rows:
            sha = canonical_sha(r["text"] or "")
            blob = await conn.fetchrow(
                "SELECT embedding::text AS emb FROM chunk_blobs "
                "WHERE workspace_id = $1 AND content_sha = $2 AND embedding IS NOT NULL",
                r["workspace_id"], sha,
            )
            if not blob or not blob["emb"]:
                continue
            await conn.execute(
                "UPDATE chunks SET embedding = $1::vector WHERE id = $2",
                blob["emb"], r["id"],
            )
            fixed += 1
            if fixed % 50 == 0:
                log.info("  …backfilled %d", fixed)
        log.info("done — scanned=%d fixed=%d", len(rows), fixed)
        return 0
    finally:
        await conn.close()


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
