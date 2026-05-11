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
from app.services.realtime_protocol import broadcast, event_payload
from app.services.ingest.pipeline import (
    EMBED_BATCH,
    EMBEDDING_MODEL,
    _chunkify,
    _dimension_for,
)

log = logging.getLogger(__name__)


def _emit_embed_progress(
    workspace_id: str,
    document_id: str,
    run_id: str,
    *,
    status: str,
    message: str,
    current: int | None = None,
    total: int | None = None,
    data: dict | None = None,
) -> None:
    """Emit a chunk_embed phase event under the canonical envelope.
    Per docs/library-client-integration.md §3.1 the desktop only
    listens for `processing_progress` / `processing_done` — using
    legacy `chunk_embed_progress` here meant the rich phase data
    (Splitting wiki into chapters / Embedded N/M / Writing) was
    dropped by the frontend. Stick to the canonical names so the
    Pipeline's Embed row picks them up live."""
    event = "processing_done" if status in {"done", "failed"} else "processing_progress"
    broadcast(
        workspace_id,
        event_payload(
            event=event,
            workspace_id=workspace_id,
            document_id=document_id,
            run_id=run_id,
            stage="chunk_embed",
            status=status,
            progress_current=current,
            progress_total=total,
            message=message,
            data=data,
        ),
    )


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
            doc_uuid,
            ws,
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
            run_id,
            ws,
            doc_uuid,
        )

    run_id_s = str(run_id)
    doc_id_s = str(doc_uuid)
    await set_ingest_progress(run_id_s, phase="chunking")
    _emit_embed_progress(
        workspace_id,
        doc_id_s,
        run_id_s,
        status="running",
        message="Splitting wiki into chapters",
        current=1,
        total=3,
        data={"phase": "chunking"},
    )
    chapters = split_wiki(content)
    if not chapters:
        async with pool().acquire() as conn:
            await conn.execute(
                "UPDATE ingest_runs SET status='done', chunk_count=0, "
                "finished_at=now() WHERE id=$1",
                run_id,
            )
        await set_ingest_progress(run_id_s, phase="done", chunk_count=0)
        _emit_embed_progress(
            workspace_id,
            doc_id_s,
            run_id_s,
            status="done",
            message="No chapter headings found",
            current=3,
            total=3,
            data={"phase": "done", "chunk_count": 0},
        )
        return {
            "ingest_run_id": str(run_id),
            "chunk_count": 0,
            "dimension": dimension,
            "status": "done",
            "chunks_reused": 0,
            "chunks_new": 0,
            "chapters": 0,
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
            flat_chunks.append(
                (
                    ch,
                    c.line_start + offset,
                    c.line_end + offset,
                    len(flat_chunks),  # global ord across the doc
                    c.text,
                    c.keywords,
                )
            )

    chunk_shas = [canonical_sha(text) for _, _, _, _, text, _ in flat_chunks]

    # ── Look up which blobs already have embeddings (skip embed) ──
    # Pull the cached embedding text along with the existence flag —
    # we need to copy it into the chunks row so the chunks table stays
    # the single source of truth for "is this chunk embedded?".
    # Without this, reused chunks land in `chunks` with embedding=NULL,
    # the /kn endpoint counts embedded_chunk_count=0, and the Pipeline
    # card shows "pending" even though the embedding exists in
    # chunk_blobs.
    cached_embeddings: dict[str, str] = {}  # content_sha → vector text
    if chunk_shas:
        async with pool().acquire() as conn:
            existing = await conn.fetch(
                """
                SELECT content_sha, embedding::text AS embedding_text
                FROM chunk_blobs
                WHERE workspace_id = $1 AND content_sha = ANY($2)
                  AND embedding IS NOT NULL
                """,
                ws,
                chunk_shas,
            )
        for r in existing:
            if r["embedding_text"]:
                cached_embeddings[r["content_sha"]] = r["embedding_text"]
    existing_with_emb = set(cached_embeddings.keys())

    chunks_reused = sum(1 for s in chunk_shas if s in existing_with_emb)
    chunks_new = len(chunk_shas) - chunks_reused

    needs_embed_idx = [
        i for i, s in enumerate(chunk_shas) if s not in existing_with_emb
    ]
    # Seed embeddings with the cached vectors so reused chunks carry
    # their embedding into the `chunks` insert below.
    embeddings: list[list[float] | str | None] = [
        cached_embeddings.get(s) for s in chunk_shas
    ]
    if needs_embed_idx:
        total_batches = (len(needs_embed_idx) + EMBED_BATCH - 1) // EMBED_BATCH
        await set_ingest_progress(
            run_id_s,
            phase="embedding",
            embed={
                "done": 0,
                "total": len(needs_embed_idx),
                "batches_total": total_batches,
            },
        )
        _emit_embed_progress(
            workspace_id,
            doc_id_s,
            run_id_s,
            status="running",
            message=f"Embedding {len(needs_embed_idx)} new wiki chunks",
            current=0,
            total=len(needs_embed_idx),
            data={
                "phase": "embedding",
                "batches_total": total_batches,
                "reused": chunks_reused,
            },
        )
        for batch_start in range(0, len(needs_embed_idx), EMBED_BATCH):
            batch_idx = needs_embed_idx[batch_start : batch_start + EMBED_BATCH]
            batch_texts = [flat_chunks[i][4] for i in batch_idx]
            try:
                vecs = await embed_texts(batch_texts)
            except Exception as e:
                log.warning(
                    "wiki embedding batch failed (offset %d): %s", batch_start, e
                )
                vecs = [None] * len(batch_texts)
            for idx, vec in zip(batch_idx, vecs):
                embeddings[idx] = vec
            done = min(batch_start + EMBED_BATCH, len(needs_embed_idx))
            await set_ingest_progress(
                run_id_s,
                embed={
                    "done": done,
                    "total": len(needs_embed_idx),
                    "batches_total": total_batches,
                },
            )
            _emit_embed_progress(
                workspace_id,
                doc_id_s,
                run_id_s,
                status="running",
                message=f"Embedded {done}/{len(needs_embed_idx)} new chunks",
                current=done,
                total=len(needs_embed_idx),
                data={
                    "phase": "embedding",
                    "batches_total": total_batches,
                    "reused": chunks_reused,
                },
            )
    else:
        _emit_embed_progress(
            workspace_id,
            doc_id_s,
            run_id_s,
            status="running",
            message=f"Reusing {chunks_reused} existing embeddings",
            current=2,
            total=3,
            data={"phase": "embedding", "reused": chunks_reused},
        )

    await set_ingest_progress(run_id_s, phase="writing")
    _emit_embed_progress(
        workspace_id,
        doc_id_s,
        run_id_s,
        status="running",
        message="Writing chapter chunks to the knowledge index",
        current=2,
        total=3,
        data={
            "phase": "writing",
            "chunk_count": len(flat_chunks),
            "chapters": len(chapters),
        },
    )

    inserted = 0
    async with pool().acquire() as conn:
        async with conn.transaction():
            # ── Replace per-doc state for idempotent re-ingest ──
            await conn.execute(
                "DELETE FROM wiki_chapters WHERE document_id = $1",
                doc_uuid,
            )
            await conn.execute(
                "DELETE FROM chunks WHERE document_id = $1 AND workspace_id = $2",
                doc_uuid,
                ws,
            )
            await conn.execute(
                "DELETE FROM chunk_refs WHERE document_id = $1 AND workspace_id = $2",
                doc_uuid,
                ws,
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
                    ws,
                    doc_uuid,
                    ch.ord,
                    ch.level,
                    ch.anchor,
                    ch.title,
                    ch.line_start,
                    ch.line_end,
                )

            # ── Chunks: dual-write legacy + new ──
            for (ch, ls, le, ord_idx, text, keywords), vec, sha in zip(
                flat_chunks, embeddings, chunk_shas
            ):
                # vec may be a freshly-computed list[float], a cached
                # vector text already in pgvector format (from
                # chunk_blobs.embedding::text), or None when neither
                # cache nor live embed produced a vector.
                if vec is None:
                    vec_lit = None
                elif isinstance(vec, str):
                    vec_lit = vec
                else:
                    vec_lit = format_vector_literal(vec)

                content_hash = hashlib.sha1(text.encode("utf-8")).hexdigest()
                source_ref = f"doc:{doc_uuid}#{ls}-{le}"
                await conn.execute(
                    """
                    INSERT INTO chunks (workspace_id, document_id, dimension,
                        source_ref, line_start, line_end, text, embedding,
                        keywords, content_hash, ingest_run_id)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8::vector, $9::jsonb, $10, $11)
                    """,
                    ws,
                    doc_uuid,
                    dimension,
                    source_ref,
                    ls,
                    le,
                    text,
                    vec_lit,
                    json.dumps(keywords, ensure_ascii=False),
                    content_hash,
                    run_id,
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
                        ws,
                        sha,
                        canonicalize(text),
                        vec_lit,
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
                        ws,
                        sha,
                        canonicalize(text),
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
                    ws,
                    doc_uuid,
                    sha,
                    ls,
                    le,
                    ord_idx,
                    run_id,
                    dimension,
                )

                inserted += 1

            await conn.execute(
                "UPDATE ingest_runs SET status='done', chunk_count=$2, "
                "finished_at=now() WHERE id=$1",
                run_id,
                inserted,
            )

    await set_ingest_progress(run_id_s, phase="done", chunk_count=inserted)
    _emit_embed_progress(
        workspace_id,
        doc_id_s,
        run_id_s,
        status="done",
        message=f"Indexed {inserted} chunks across {len(chapters)} chapters",
        current=3,
        total=3,
        data={
            "phase": "done",
            "chunk_count": inserted,
            "chapters": len(chapters),
            "reused": chunks_reused,
        },
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
