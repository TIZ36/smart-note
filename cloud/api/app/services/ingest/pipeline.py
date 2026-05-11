"""Cloud-side ingest pipeline — runs once, all devices read.

Steps:
  1. Fetch the document content (already in cloud `documents` after sync push)
  2. Split markdown into paragraph-level chunks (200-1500 chars)
  3. Embed each chunk via the embed pod
  4. Persist into `chunks` with embedding + tsvector + keyword extraction
  5. Mark the ingest_run done

What this DOESN'T do (yet): NER for entities, AI tag classification.
Those live in `services/enrich/classifier.py` (executor-registry path)
and stay decoupled — caller can choose to fire `/v1/enrich/run` after
ingest finishes if they want LLM-driven tagging.

Idempotent on document_id: re-ingest deletes prior chunks for the
same document before inserting the new run's rows.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
from collections import Counter
from dataclasses import dataclass
from typing import Any
from uuid import UUID, uuid4

from app.common.db import pool
from app.services.enrich.progress import set_ingest_progress
from app.services.embedding.client import embed_texts, format_vector_literal
from app.services.realtime_protocol import broadcast, event_payload

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
    data: dict[str, Any] | None = None,
) -> None:
    """Phase event for the note ingest path. Same canonical envelope
    as wiki_processor (and as docs/library-client-integration.md §3.1).
    Legacy `chunk_embed_*` event names were dropped because the
    desktop only listens to `processing_progress` / `processing_done`."""
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


# ── Tunables ──────────────────────────────────────────────────
MIN_CHUNK_CHARS = 200
MAX_CHUNK_CHARS = 1500
TOP_KEYWORDS = 12
KEYWORD_MIN_LEN = 2
EMBED_BATCH = 32

# Label written into chunk_blobs.embedding_model so we can identify
# which sentence-transformer model produced a vector. Read from the
# same env var the embed pod uses (cloud/infra/.env :: EMBED_MODEL),
# defaulting to MiniLM. Wiki processor + future re-embed paths share
# this label so old + new chunk_blobs rows can be reconciled.
EMBEDDING_MODEL = os.environ.get(
    "EMBED_MODEL", "sentence-transformers/all-MiniLM-L6-v2",
)

_TOKEN_RE = re.compile(r"[A-Za-z0-9_]+|[一-鿿]+")
_STOP_EN = {
    "the",
    "and",
    "for",
    "with",
    "that",
    "this",
    "from",
    "are",
    "was",
    "but",
    "not",
    "you",
    "your",
    "have",
    "has",
    "had",
    "can",
    "all",
    "any",
    "one",
    "out",
    "how",
    "use",
    "also",
    "into",
    "more",
    "than",
    "they",
    "them",
    "then",
    "there",
    "their",
    "these",
    "those",
    "will",
    "would",
    "could",
    "should",
    "about",
    "which",
    "where",
    "when",
}


@dataclass
class Chunk:
    text: str
    line_start: int
    line_end: int
    keywords: list[str]


def _chunkify(content: str) -> list[Chunk]:
    """Greedy paragraph accumulator: keep adding paragraphs until the
    buffer is between MIN and MAX chars; flush; repeat. Falls back to
    one chunk per file when the document is shorter than MIN."""
    out: list[Chunk] = []
    buf: list[str] = []
    buf_start = 1
    cur_line = 1

    def flush():
        nonlocal buf, buf_start
        if not buf:
            return
        text = "\n\n".join(buf).strip()
        if not text:
            buf = []
            return
        out.append(
            Chunk(
                text=text,
                line_start=buf_start,
                line_end=max(buf_start, cur_line - 1),
                keywords=_keywords(text),
            )
        )
        buf = []

    for para in re.split(r"\n\s*\n", content):
        para = para.rstrip()
        if not para:
            cur_line += 1
            continue
        para_lines = para.count("\n") + 1
        para_start = cur_line
        cur_line += para_lines + 1
        candidate_len = sum(len(b) + 2 for b in buf) + len(para)
        if candidate_len <= MAX_CHUNK_CHARS:
            if not buf:
                buf_start = para_start
            buf.append(para)
            if candidate_len >= MIN_CHUNK_CHARS:
                flush()
                buf_start = cur_line
        else:
            flush()
            buf_start = para_start
            buf.append(para)
            if len(para) >= MIN_CHUNK_CHARS:
                flush()
                buf_start = cur_line
    flush()
    if not out and content.strip():
        # Tiny document — one chunk for the whole thing.
        out.append(
            Chunk(
                text=content.strip(),
                line_start=1,
                line_end=max(1, content.count("\n") + 1),
                keywords=_keywords(content),
            )
        )
    return out


def _keywords(text: str) -> list[str]:
    counts: Counter[str] = Counter()
    for tok in _TOKEN_RE.findall(text):
        t = tok.lower()
        if len(t) < KEYWORD_MIN_LEN or t in _STOP_EN:
            continue
        counts[t] += 1
    return [w for w, _ in counts.most_common(TOP_KEYWORDS)]


def _dimension_for(doc: dict) -> str:
    """Pull the dimension string from document metadata. Wiki topics
    get 'wiki:<topic>'; notes get 'note'. Mirrors the local schema so
    retrieval filters Just Work."""
    md = doc.get("metadata") or {}
    kind = md.get("smartnote_type") or "note"
    if kind == "wiki_topic":
        rel = md.get("relative_path") or md.get("local_path") or ""
        # Top-level dir (or filename stem when at root) becomes the topic.
        parts = [p for p in rel.replace("\\", "/").split("/") if p]
        topic = (
            parts[0]
            if len(parts) > 1
            else (parts[0].rsplit(".", 1)[0] if parts else "general")
        )
        return f"wiki:{topic}"
    return "note"


async def ingest_document(workspace_id: str, document_id: str) -> dict:
    """Ingest one document into the cloud chunks index. Idempotent —
    a re-run replaces all chunks for this document with a fresh set
    keyed by a new ingest_run_id.

    Returns: { ingest_run_id, chunk_count, dimension, status }
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

        run_row = await conn.fetchrow(
            "INSERT INTO ingest_runs (id, workspace_id, document_id, status, started_at) "
            "VALUES ($1, $2, $3, 'running', now()) RETURNING id",
            run_id,
            ws,
            doc_uuid,
        )

    run_id_s = str(run_id)
    doc_id_s = str(doc_uuid)
    await set_ingest_progress(run_id_s, phase="reading")
    _emit_embed_progress(
        workspace_id,
        doc_id_s,
        run_id_s,
        status="running",
        message="Reading document",
        current=0,
        total=3,
        data={"phase": "reading"},
    )

    await set_ingest_progress(run_id_s, phase="chunking")
    _emit_embed_progress(
        workspace_id,
        doc_id_s,
        run_id_s,
        status="running",
        message="Splitting text into searchable chunks",
        current=1,
        total=3,
        data={"phase": "chunking"},
    )
    chunks = _chunkify(content)
    if not chunks:
        async with pool().acquire() as conn:
            await conn.execute(
                "UPDATE ingest_runs SET status='done', chunk_count=0, finished_at=now() "
                "WHERE id=$1",
                run_id,
            )
        await set_ingest_progress(run_id_s, phase="done", chunk_count=0)
        _emit_embed_progress(
            workspace_id,
            doc_id_s,
            run_id_s,
            status="done",
            message="No chunkable text found",
            current=3,
            total=3,
            data={"phase": "done", "chunk_count": 0},
        )
        return {
            "ingest_run_id": str(run_id),
            "chunk_count": 0,
            "dimension": dimension,
            "status": "done",
        }

    # Embed in batches; don't block the whole pipeline if a single
    # batch fails — store NULL embeddings so chunks are at least
    # text-searchable, and a follow-up pass can re-embed later.
    embeddings: list[list[float] | None] = []
    total_batches = (len(chunks) + EMBED_BATCH - 1) // EMBED_BATCH
    await set_ingest_progress(
        run_id_s,
        phase="embedding",
        embed={"done": 0, "total": len(chunks), "batches_total": total_batches},
    )
    _emit_embed_progress(
        workspace_id,
        doc_id_s,
        run_id_s,
        status="running",
        message=f"Embedding {len(chunks)} chunks",
        current=0,
        total=len(chunks),
        data={"phase": "embedding", "batches_total": total_batches},
    )
    for i in range(0, len(chunks), EMBED_BATCH):
        batch_texts = [c.text for c in chunks[i : i + EMBED_BATCH]]
        try:
            vecs = await embed_texts(batch_texts)
        except Exception as e:
            log.warning("ingest embedding batch failed (offset %d): %s", i, e)
            vecs = [None] * len(batch_texts)
        embeddings.extend(vecs)
        done = min(i + EMBED_BATCH, len(chunks))
        await set_ingest_progress(
            run_id_s,
            embed={"done": done, "total": len(chunks), "batches_total": total_batches},
        )
        _emit_embed_progress(
            workspace_id,
            doc_id_s,
            run_id_s,
            status="running",
            message=f"Embedded {done}/{len(chunks)} chunks",
            current=done,
            total=len(chunks),
            data={"phase": "embedding", "batches_total": total_batches},
        )

    inserted = 0
    await set_ingest_progress(run_id_s, phase="writing")
    _emit_embed_progress(
        workspace_id,
        doc_id_s,
        run_id_s,
        status="running",
        message="Writing chunks to the knowledge index",
        current=2,
        total=3,
        data={"phase": "writing", "chunk_count": len(chunks)},
    )
    async with pool().acquire() as conn:
        async with conn.transaction():
            # Replace prior chunks for this document — re-ingest
            # semantics. Old runs' rows are GC'd; sync_state on the
            # local side keys on document_id, not run_id.
            await conn.execute(
                "DELETE FROM chunks WHERE document_id = $1 AND workspace_id = $2",
                doc_uuid,
                ws,
            )
            for c, vec in zip(chunks, embeddings):
                vec_lit = format_vector_literal(vec) if vec is not None else None
                content_hash = hashlib.sha1(c.text.encode("utf-8")).hexdigest()
                source_ref = f"doc:{doc_uuid}#{c.line_start}-{c.line_end}"
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
                    c.line_start,
                    c.line_end,
                    c.text,
                    vec_lit,
                    json.dumps(c.keywords, ensure_ascii=False),
                    content_hash,
                    run_id,
                )
                inserted += 1
            await conn.execute(
                "UPDATE ingest_runs SET status='done', chunk_count=$2, "
                "finished_at=now() WHERE id=$1",
                run_id,
                inserted,
            )
            # Mark the document as ingested so list_documents /
            # console_overview reflect post-embed state. Without this
            # the desktop UI never lights its E (embedded) badge —
            # documents.ingested_at stays NULL even though chunks are
            # populated.
            await conn.execute(
                "UPDATE documents SET ingested_at = now() WHERE id = $1",
                doc_uuid,
            )
    await set_ingest_progress(run_id_s, phase="done", chunk_count=inserted)
    _emit_embed_progress(
        workspace_id,
        doc_id_s,
        run_id_s,
        status="done",
        message=f"Indexed {inserted} chunks",
        current=3,
        total=3,
        data={"phase": "done", "chunk_count": inserted, "dimension": dimension},
    )
    return {
        "ingest_run_id": str(run_id),
        "chunk_count": inserted,
        "dimension": dimension,
        "status": "done",
    }


async def ingest_run_status(workspace_id: str, run_id: str) -> dict | None:
    async with pool().acquire() as conn:
        row = await conn.fetchrow(
            "SELECT id, document_id, status, chunk_count, error, "
            "started_at, finished_at, created_at FROM ingest_runs "
            "WHERE id = $1 AND workspace_id = $2",
            UUID(run_id),
            UUID(workspace_id),
        )
    if not row:
        return None
    return {
        "id": str(row["id"]),
        "document_id": str(row["document_id"]),
        "status": row["status"],
        "chunk_count": row["chunk_count"],
        "error": row["error"],
        "started_at": row["started_at"].isoformat() if row["started_at"] else None,
        "finished_at": row["finished_at"].isoformat() if row["finished_at"] else None,
        "created_at": row["created_at"].isoformat(),
    }
