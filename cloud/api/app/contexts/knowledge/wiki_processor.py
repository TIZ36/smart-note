"""Wiki Phase A processor — populates wiki_chapters + chunks-per-chapter.

Called by knowledge.wiring when a `smartnote_type='wiki_topic'`
document lands. The note path stays on `services/ingest/pipeline.py`;
this module handles the per-H2 split + chapter persistence that
notes don't need.

Flow:
  1. Run split_wiki() to extract chapters.
  2. UPSERT wiki_chapters rows (replace per-doc on re-ingest so
     ord stays monotonic).
  3. For each chapter, paragraph-chunk its body and write
     chunk_blobs / chunk_refs the same way pipeline.ingest_document
     does. We reuse the legacy `chunks` write path too so the dual-
     write contract holds.

Phase B (LLM summary per chapter) lives in `wiki_phase_b.py`. This
file is structurally cheap and runs on every wiki upload.
"""

from __future__ import annotations

import hashlib
import json
import logging
from uuid import UUID, uuid4

from app.common.db import pool
from app.contexts.knowledge.wiki_splitter import Chapter, split_wiki
from app.infra.canonical import canonical_sha, canonicalize
from app.services.embedding.client import embed_texts, format_vector_literal
from app.services.enrich.progress import set_ingest_progress
from app.services.ingest.pipeline import (
    EMBED_BATCH, EMBEDDING_MODEL, _chunkify, _dimension_for,
)

log = logging.getLogger(__name__)


async def process_wiki_document(workspace_id: str, document_id: str) -> dict:
    """Phase A for a wiki_topic document. Returns the same shape as
    pipeline.ingest_document so callers / tests don't have to branch:

        { ingest_run_id, chunk_count, dimension, status,
          chunks_reused, chunks_new, chapters }
    """
    ws = UUID(workspace_id)
    doc_uuid = UUID(document_id)
    run_id = uuid4()

    async with pool().acquire() as conn:
        doc = await conn.fetchrow(
            "SELECT id, name, content, metadata FROM documents "
            "WHERE id = $1 AND workspace_id = $2",
            doc_uuid, ws,
        )
        if not doc:
            return {"status": "error", "error": "document not found"}

        content = doc["content"] or ""
        meta = doc["metadata"] or {}
        if isinstance(meta, str):
            try:
                meta = json.loads(meta)
            except Exception:
                meta = {}
        dimension = _dimension_for({"metadata": meta})

        await conn.execute(
            "INSERT INTO ingest_runs (id, workspace_id, document_id, status, started_at) "
            "VALUES ($1, $2, $3, 'running', now())",
            run_id, ws, doc_uuid,
        )

    await set_ingest_progress(str(run_id), phase="chunking")
    chapters = split_wiki(content)
    if not chapters:
        async with pool().acquire() as conn:
            await conn.execute(
                "UPDATE ingest_runs SET status='done', chunk_count=0, "
                "finished_at=now() WHERE id=$1",
                run_id,
            )
        return {
            "ingest_run_id": str(run_id), "chunk_count": 0,
            "dimension": dimension, "status": "done",
            "chunks_reused": 0, "chunks_new": 0, "chapters": 0,
        }

    # ── Per-chapter chunking ──
    # Each chapter is paragraph-chunked independently so chunk
    # boundaries respect chapter boundaries (a paragraph that spans
    # the heading line never ends up in the wrong chapter). Chapter
    # line_start anchors line numbers back to the doc.
    flat_chunks: list[tuple[Chapter, int, int, int, str, list[str]]] = []
    for ch in chapters:
        # _chunkify returns line numbers RELATIVE to its input, starting
        # at 1. Translate them to absolute doc line numbers by offset.
        offset = ch.line_start - 1
        for c in _chunkify(ch.text):
            flat_chunks.append((
                ch,
                c.line_start + offset,
                c.line_end + offset,
                len(flat_chunks),  # global ord across the doc
                c.text,
                c.keywords,
            ))

    chunk_shas = [canonical_sha(text) for _, _, _, _, text, _ in flat_chunks]

    # ── Look up which blobs already have embeddings (skip embed) ──
    if chunk_shas:
        async with pool().acquire() as conn:
            existing = await conn.fetch(
                """
                SELECT content_sha, embedding IS NOT NULL AS has_embedding
                FROM chunk_blobs
                WHERE workspace_id = $1 AND content_sha = ANY($2)
                """,
                ws, chunk_shas,
            )
        existing_with_emb: set[str] = {
            r["content_sha"] for r in existing if r["has_embedding"]
        }
    else:
        existing_with_emb = set()

    chunks_reused = sum(1 for s in chunk_shas if s in existing_with_emb)
    chunks_new = len(chunk_shas) - chunks_reused

    needs_embed_idx = [
        i for i, s in enumerate(chunk_shas) if s not in existing_with_emb
    ]
    embeddings: list[list[float] | None] = [None] * len(flat_chunks)
    if needs_embed_idx:
        total_batches = (len(needs_embed_idx) + EMBED_BATCH - 1) // EMBED_BATCH
        await set_ingest_progress(
            str(run_id), phase="embedding",
            embed={"done": 0, "total": len(needs_embed_idx),
                   "batches_total": total_batches},
        )
        for batch_start in range(0, len(needs_embed_idx), EMBED_BATCH):
            batch_idx = needs_embed_idx[batch_start:batch_start + EMBED_BATCH]
            batch_texts = [flat_chunks[i][4] for i in batch_idx]
            try:
                vecs = await embed_texts(batch_texts)
            except Exception as e:
                log.warning("wiki embedding batch failed (offset %d): %s", batch_start, e)
                vecs = [None] * len(batch_texts)
            for idx, vec in zip(batch_idx, vecs):
                embeddings[idx] = vec
            await set_ingest_progress(
                str(run_id),
                embed={
                    "done": min(batch_start + EMBED_BATCH, len(needs_embed_idx)),
                    "total": len(needs_embed_idx),
                    "batches_total": total_batches,
                },
            )

    await set_ingest_progress(str(run_id), phase="writing")

    inserted = 0
    async with pool().acquire() as conn:
        async with conn.transaction():
            # ── Replace per-doc state for idempotent re-ingest ──
            await conn.execute(
                "DELETE FROM wiki_chapters WHERE document_id = $1", doc_uuid,
            )
            await conn.execute(
                "DELETE FROM chunks WHERE document_id = $1 AND workspace_id = $2",
                doc_uuid, ws,
            )
            await conn.execute(
                "DELETE FROM chunk_refs WHERE document_id = $1 AND workspace_id = $2",
                doc_uuid, ws,
            )

            # ── wiki_chapters rows ──
            for ch in chapters:
                await conn.execute(
                    """
                    INSERT INTO wiki_chapters
                      (workspace_id, document_id, ord, level, anchor, title,
                       line_start, line_end)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                    ON CONFLICT (document_id, ord) DO UPDATE
                      SET level = EXCLUDED.level,
                          anchor = EXCLUDED.anchor,
                          title = EXCLUDED.title,
                          line_start = EXCLUDED.line_start,
                          line_end = EXCLUDED.line_end,
                          updated_at = now()
                    """,
                    ws, doc_uuid, ch.ord, ch.level, ch.anchor, ch.title,
                    ch.line_start, ch.line_end,
                )

            # ── Chunks: dual-write legacy + new ──
            for (ch, ls, le, ord_idx, text, keywords), vec, sha in zip(
                flat_chunks, embeddings, chunk_shas
            ):
                vec_lit = format_vector_literal(vec) if vec is not None else None

                content_hash = hashlib.sha1(text.encode("utf-8")).hexdigest()
                source_ref = f"doc:{doc_uuid}#{ls}-{le}"
                await conn.execute(
                    """
                    INSERT INTO chunks (workspace_id, document_id, dimension,
                        source_ref, line_start, line_end, text, embedding,
                        keywords, content_hash, ingest_run_id)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8::vector, $9::jsonb, $10, $11)
                    """,
                    ws, doc_uuid, dimension, source_ref,
                    ls, le, text, vec_lit,
                    json.dumps(keywords, ensure_ascii=False),
                    content_hash, run_id,
                )

                if vec_lit is not None:
                    await conn.execute(
                        """
                        INSERT INTO chunk_blobs (workspace_id, content_sha,
                            text, embedding, embedding_model, keywords)
                        VALUES ($1, $2, $3, $4::vector, $5, $6::jsonb)
                        ON CONFLICT (workspace_id, content_sha) DO UPDATE
                          SET embedding = COALESCE(chunk_blobs.embedding, EXCLUDED.embedding)
                        """,
                        ws, sha, canonicalize(text), vec_lit,
                        EMBEDDING_MODEL,
                        json.dumps(keywords, ensure_ascii=False),
                    )
                else:
                    await conn.execute(
                        """
                        INSERT INTO chunk_blobs (workspace_id, content_sha,
                            text, embedding, embedding_model, keywords)
                        VALUES ($1, $2, $3, NULL, $4, $5::jsonb)
                        ON CONFLICT (workspace_id, content_sha) DO NOTHING
                        """,
                        ws, sha, canonicalize(text),
                        EMBEDDING_MODEL,
                        json.dumps(keywords, ensure_ascii=False),
                    )

                await conn.execute(
                    """
                    INSERT INTO chunk_refs (workspace_id, document_id,
                        chunk_sha, line_start, line_end, ord, ingest_run_id,
                        dimension)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                    ON CONFLICT (document_id, ord) DO NOTHING
                    """,
                    ws, doc_uuid, sha, ls, le, ord_idx, run_id, dimension,
                )

                inserted += 1

            await conn.execute(
                "UPDATE ingest_runs SET status='done', chunk_count=$2, "
                "finished_at=now() WHERE id=$1",
                run_id, inserted,
            )

    return {
        "ingest_run_id": str(run_id),
        "chunk_count": inserted,
        "dimension": dimension,
        "status": "done",
        "chunks_reused": chunks_reused,
        "chunks_new": chunks_new,
        "chapters": len(chapters),
    }
