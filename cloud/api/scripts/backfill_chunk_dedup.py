"""Backfill legacy `chunks` rows into `chunk_blobs` + `chunk_refs`.

See docs/processing-pipeline.md §7.4.

Race-safe by design — both inserts use `ON CONFLICT DO NOTHING`,
backed by:
  - chunk_blobs PK (workspace_id, content_sha)
  - chunk_refs UNIQUE (document_id, ord)        -- migration 020

Either constraint absorbs duplicate writes from a live writer racing
this script, so the script can run alongside dual-write (P1+) without
a maintenance window.

Why the canonicalize-and-rehash:
  Legacy `chunks` rows store `text` as written; the new dedup keys
  off canonicalized form. We hash the canonical version so the same
  paragraph stored two different ways (CRLF vs LF, trailing space)
  collapses into one blob.

Run cadence:
  - P0-5: write + verify (this file lands; never run yet)
  - P1-5: initial pass, after dual-write begins
  - P4-1: catch-up pass before search reads flip to chunks_v

Usage:
  DATABASE_URL=postgresql://... python -m scripts.backfill_chunk_dedup
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import re
import sys
import time

import asyncpg

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s: %(message)s")
log = logging.getLogger("backfill_chunk_dedup")

BATCH = 1_000
SLEEP_S = 0.05
DEFAULT_MODEL = "all-MiniLM-L6-v2"


def canonicalize(text: str) -> str:
    """Mirror of `app.infra.canonical.canonicalize`. Lifted here so
    the backfill can run as a standalone script (no app imports). Keep
    the two definitions byte-identical or chunk_sha will diverge.

    Spec: see app/infra/canonical.py docstring."""
    if not text:
        return ""
    if text.startswith("﻿"):
        text = text[1:]
    text = text.replace("\r\n", "\n").replace("\r", "\n").strip()
    text = "\n".join(line.rstrip(" \t") for line in text.split("\n"))
    return re.sub(r"[ \t]+", " ", text)


def sha256_hex(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _dimension_from_metadata(meta) -> str:
    """Derive `dimension` for chunk_refs when the legacy chunks row
    didn't carry one. Mirrors `_dimension_for` in pipeline.py — keep
    in sync. JSONB → dict from asyncpg; treat str as raw JSON."""
    import json as _json

    if isinstance(meta, str):
        try:
            meta = _json.loads(meta)
        except Exception:
            meta = {}
    md = meta or {}
    kind = md.get("smartnote_type") or "note"
    if kind != "wiki_topic":
        return "note"
    rel = md.get("relative_path") or md.get("local_path") or ""
    parts = [p for p in rel.replace("\\", "/").split("/") if p]
    topic = parts[0] if len(parts) > 1 else (
        parts[0].rsplit(".", 1)[0] if parts else "general"
    )
    return f"wiki:{topic}"


async def main() -> int:
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        log.error("DATABASE_URL not set")
        return 2
    dsn = dsn.replace("postgresql+asyncpg://", "postgresql://", 1)

    conn = await asyncpg.connect(dsn=dsn)
    try:
        total = 0
        skipped = 0
        started = time.monotonic()

        # Discover whether the legacy chunks table has the columns we
        # expect. If a deployment lacks `embedding_model` (it didn't
        # exist before v1.2), we fall back to DEFAULT_MODEL.
        cols = {r["column_name"] for r in await conn.fetch(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_name = 'chunks'"
        )}
        has_embedding_model = "embedding_model" in cols
        has_keywords = "keywords" in cols
        has_ord = "ord" in cols
        if not has_ord:
            log.error("legacy chunks table missing `ord` column; "
                      "cannot satisfy chunk_refs.ord NOT NULL. Update "
                      "the migration that added `ord` and re-run.")
            return 3

        while True:
            # Pull legacy chunks alongside their owning doc's metadata
            # so we can derive `dimension` for chunk_refs without a
            # second round trip per row. Legacy `chunks.dimension` is
            # also a column we can fall back on when present.
            rows = await conn.fetch("""
                SELECT c.id, c.workspace_id, c.document_id, c.text, c.embedding,
                       c.line_start, c.line_end, c.ord, c.ingest_run_id,
                       c.dimension AS legacy_dimension,
                       d.metadata  AS doc_metadata
                       %s %s
                FROM chunks c
                JOIN documents d ON d.id = c.document_id
                WHERE NOT EXISTS (
                  SELECT 1 FROM chunk_refs cr
                  WHERE cr.document_id = c.document_id
                    AND cr.ord         = c.ord
                )
                ORDER BY c.id
                LIMIT $1
            """ % (
                ", c.embedding_model" if has_embedding_model else "",
                ", c.keywords" if has_keywords else "",
            ), BATCH)
            if not rows:
                break

            for r in rows:
                canonical = canonicalize(r["text"] or "")
                sha = sha256_hex(canonical)
                model = (r["embedding_model"] if has_embedding_model
                         else None) or DEFAULT_MODEL
                keywords = r["keywords"] if has_keywords else "[]"
                dimension = r["legacy_dimension"] or _dimension_from_metadata(
                    r["doc_metadata"]
                )

                # Two inserts. Both ON CONFLICT clauses are essential:
                # backfill row racing a live dual-write row resolves
                # cleanly, with the live row winning.
                await conn.execute("""
                    INSERT INTO chunk_blobs (workspace_id, content_sha,
                      text, embedding, embedding_model, keywords)
                    VALUES ($1, $2, $3, $4, $5, $6)
                    ON CONFLICT (workspace_id, content_sha) DO NOTHING
                """, r["workspace_id"], sha, canonical, r["embedding"],
                    model, keywords)

                inserted = await conn.execute("""
                    INSERT INTO chunk_refs (workspace_id, document_id,
                      chunk_sha, line_start, line_end, ord, ingest_run_id,
                      dimension)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                    ON CONFLICT (document_id, ord) DO NOTHING
                """, r["workspace_id"], r["document_id"], sha,
                    r["line_start"], r["line_end"], r["ord"],
                    r["ingest_run_id"], dimension)
                if inserted.endswith(" 1"):
                    total += 1
                else:
                    skipped += 1

            elapsed = time.monotonic() - started
            log.info("processed batch: total_inserted=%d skipped=%d (%.1fs)",
                     total, skipped, elapsed)
            await asyncio.sleep(SLEEP_S)

        log.info("done. inserted=%d skipped=%d in %.1fs",
                 total, skipped, time.monotonic() - started)
        return 0
    finally:
        await conn.close()


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
