"""Cloud-side ingest + chunk search.

POST /v1/ingest/document        — parse → chunk → embed one document
POST /v1/ingest/bulk            — same, for many docs in one call
POST /v1/ingest/by-topic        — ingest every doc tagged smartnote_type=wiki_topic
                                  whose metadata.relative_path starts with <topic>
GET  /v1/ingest/runs/{id}       — poll run status
GET  /v1/ingest/sources         — distinct (document, dimension) currently
                                  represented in chunks (powers Wiki UI cloud-side)
GET  /v1/ingest/topics          — distinct dimensions, with chunk counts
POST /v1/chunks/search          — 6-path hybrid retrieval over chunks (cloud
                                  search; replaces local /search for the
                                  Search panel when cloud is configured)

The endpoints sit behind `documents:write` / `documents:read` scopes
so only an authenticated workspace member can drive them. Bulk routes
fan out internally; we don't trust raw doc-id lists from clients.
"""

from __future__ import annotations

import json
import logging
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from app.common.db import pool
from app.deps import Identity, require_scope
from app.services.ingest.pipeline import ingest_document, ingest_run_status
from app.services.kb import chunk_search

router = APIRouter(prefix="/v1", tags=["ingest"])

log = logging.getLogger(__name__)


# ── /v1/ingest ─────────────────────────────────────────────────

class IngestDocumentRequest(BaseModel):
    document_id: str


class IngestDocumentResponse(BaseModel):
    ingest_run_id: str
    chunk_count: int
    dimension: str
    status: str


@router.post(
    "/ingest/document",
    response_model=IngestDocumentResponse,
    dependencies=[Depends(require_scope("documents:write"))],
)
async def ingest_one(
    req: IngestDocumentRequest,
    identity: Identity = Depends(require_scope("documents:write")),
) -> IngestDocumentResponse:
    out = await ingest_document(identity.workspace_id, req.document_id)
    if out.get("status") == "error":
        raise HTTPException(status.HTTP_400_BAD_REQUEST, out.get("error", "ingest failed"))
    return IngestDocumentResponse(**out)


class BulkIngestRequest(BaseModel):
    document_ids: list[str] = Field(default_factory=list)
    smartnote_type: str | None = None  # filter by metadata.smartnote_type
    topic_prefix: str | None = None    # filter wiki by relative_path prefix


class BulkIngestResponse(BaseModel):
    total: int
    ingested: int
    chunks: int
    failures: list[dict]


@router.post(
    "/ingest/bulk",
    response_model=BulkIngestResponse,
    dependencies=[Depends(require_scope("documents:write"))],
)
async def ingest_bulk(
    req: BulkIngestRequest,
    identity: Identity = Depends(require_scope("documents:write")),
) -> BulkIngestResponse:
    """Ingest many documents serially. The pipeline is single-threaded
    on a doc — we don't parallelize because the embed pod is small and
    parallel calls fight the same GPU. Caller passes either an
    explicit document_ids list, or a smartnote_type filter, or both."""
    ws = UUID(identity.workspace_id)
    target_ids: list[str] = list(req.document_ids)

    if req.smartnote_type:
        async with pool().acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT id, metadata FROM documents
                WHERE workspace_id = $1
                  AND (metadata->>'smartnote_type') = $2
                """,
                ws, req.smartnote_type,
            )
        for r in rows:
            md = r["metadata"] or {}
            if isinstance(md, str):
                try:
                    md = json.loads(md)
                except Exception:
                    md = {}
            rel = (md.get("relative_path") or "").replace("\\", "/")
            if req.topic_prefix and not rel.startswith(req.topic_prefix):
                continue
            target_ids.append(str(r["id"]))

    seen: set[str] = set()
    ordered: list[str] = []
    for d in target_ids:
        if d not in seen:
            seen.add(d)
            ordered.append(d)

    failures: list[dict] = []
    chunks_total = 0
    ingested_count = 0
    for doc_id in ordered:
        try:
            out = await ingest_document(identity.workspace_id, doc_id)
            if out.get("status") == "done":
                ingested_count += 1
                chunks_total += int(out.get("chunk_count") or 0)
            else:
                failures.append({"document_id": doc_id, "error": out.get("error", "unknown")})
        except Exception as e:
            log.exception("bulk ingest failed for %s", doc_id)
            failures.append({"document_id": doc_id, "error": str(e)})
    return BulkIngestResponse(
        total=len(ordered), ingested=ingested_count,
        chunks=chunks_total, failures=failures,
    )


class IngestRunStatusOut(BaseModel):
    id: str
    document_id: str
    status: str
    chunk_count: int
    error: str | None = None
    started_at: str | None = None
    finished_at: str | None = None
    created_at: str


@router.get(
    "/ingest/runs/{run_id}",
    response_model=IngestRunStatusOut,
    dependencies=[Depends(require_scope("documents:read"))],
)
async def get_run(
    run_id: str,
    identity: Identity = Depends(require_scope("documents:read")),
) -> IngestRunStatusOut:
    out = await ingest_run_status(identity.workspace_id, run_id)
    if not out:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "ingest run not found")
    return IngestRunStatusOut(**out)


# ── /v1/ingest/sources + /v1/ingest/topics ─────────────────────

class ChunkSource(BaseModel):
    document_id: str
    document_name: str
    dimension: str
    chunk_count: int
    last_ingested_at: str | None


@router.get(
    "/ingest/sources",
    response_model=list[ChunkSource],
    dependencies=[Depends(require_scope("documents:read"))],
)
async def list_sources(
    identity: Identity = Depends(require_scope("documents:read")),
) -> list[ChunkSource]:
    """Every (document, dimension) currently in chunks. Powers the
    desktop's Wiki Sources panel when cloud is configured —
    counterpart to local `/wiki-sources`."""
    async with pool().acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT c.document_id, d.name, c.dimension,
                   count(*) AS chunk_count,
                   max(c.created_at) AS last_at
            FROM chunks c JOIN documents d ON d.id = c.document_id
            WHERE c.workspace_id = $1
            GROUP BY c.document_id, d.name, c.dimension
            ORDER BY d.name
            """,
            UUID(identity.workspace_id),
        )
    return [
        ChunkSource(
            document_id=str(r["document_id"]),
            document_name=r["name"],
            dimension=r["dimension"],
            chunk_count=int(r["chunk_count"]),
            last_ingested_at=r["last_at"].isoformat() if r["last_at"] else None,
        )
        for r in rows
    ]


class ChunkTopic(BaseModel):
    dimension: str
    chunk_count: int
    document_count: int


@router.get(
    "/ingest/topics",
    response_model=list[ChunkTopic],
    dependencies=[Depends(require_scope("documents:read"))],
)
async def list_topics(
    identity: Identity = Depends(require_scope("documents:read")),
) -> list[ChunkTopic]:
    """Every dimension currently in chunks, with counts. Powers
    Special Knowledge Wiki tab cloud-side."""
    async with pool().acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT dimension,
                   count(*) AS chunk_count,
                   count(DISTINCT document_id) AS doc_count
            FROM chunks WHERE workspace_id = $1
            GROUP BY dimension ORDER BY dimension
            """,
            UUID(identity.workspace_id),
        )
    return [
        ChunkTopic(
            dimension=r["dimension"],
            chunk_count=int(r["chunk_count"]),
            document_count=int(r["doc_count"]),
        )
        for r in rows
    ]


# ── /v1/chunks/search ──────────────────────────────────────────

class ChunkSearchRequest(BaseModel):
    query: str
    topk: int = 20
    dimension: str | None = None  # filter to one topic, e.g. 'wiki:回传'


class ChunkSearchHit(BaseModel):
    id: str
    document_id: str
    document_name: str
    dimension: str
    text: str
    keywords: list[str]
    line_start: int
    line_end: int
    source_ref: str
    score: float
    path_scores: dict[str, float]


class ChunkSearchResponse(BaseModel):
    results: list[ChunkSearchHit]
    query_embedded: bool


@router.post(
    "/chunks/search",
    response_model=ChunkSearchResponse,
    dependencies=[Depends(require_scope("documents:read"))],
)
async def search_chunks(
    req: ChunkSearchRequest,
    identity: Identity = Depends(require_scope("documents:read")),
) -> ChunkSearchResponse:
    hits = await chunk_search.search(
        req.query, identity.workspace_id,
        topk=req.topk, dimension=req.dimension,
    )
    # Record into search_history for cross-device "recent searches".
    # Best-effort — failure here doesn't block the response.
    try:
        from app.routers.search_history import record as _record_history
        await _record_history(
            identity.workspace_id, req.query, len(hits), req.dimension,
        )
    except Exception:
        pass
    return ChunkSearchResponse(
        query_embedded=any(h.path_scores.get("vec", 0) > 0 for h in hits),
        results=[
            ChunkSearchHit(
                id=h.id, document_id=h.document_id, document_name=h.document_name,
                dimension=h.dimension, text=h.text, keywords=h.keywords,
                line_start=h.line_start, line_end=h.line_end,
                source_ref=h.source_ref, score=h.score, path_scores=h.path_scores,
            )
            for h in hits
        ],
    )


# ── /v1/chunks/{id}/source — preview context ────────────────────

class ChunkSourceLine(BaseModel):
    line: int
    text: str
    highlight: bool


class ChunkSourceResponse(BaseModel):
    document_id: str
    document_name: str
    dimension: str
    line_start: int
    line_end: int
    target_line: int
    lines: list[ChunkSourceLine]


@router.get(
    "/chunks/{chunk_id}/source",
    response_model=ChunkSourceResponse,
    dependencies=[Depends(require_scope("documents:read"))],
)
async def chunk_source(
    chunk_id: str,
    context: int = 5,
    identity: Identity = Depends(require_scope("documents:read")),
) -> ChunkSourceResponse:
    """Return the chunk's lines with a few lines of surrounding
    document context for the SourcePreview pane. Replaces local
    /source for cloud-pulled chunks."""
    async with pool().acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT c.id, c.document_id, c.dimension, c.line_start, c.line_end,
                   d.name AS document_name, d.content AS document_content
            FROM chunks c JOIN documents d ON d.id = c.document_id
            WHERE c.id = $1 AND c.workspace_id = $2
            """,
            UUID(chunk_id), UUID(identity.workspace_id),
        )
    if not row:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "chunk not found")

    all_lines = (row["document_content"] or "").splitlines()
    start = max(1, int(row["line_start"]) - context)
    end = min(len(all_lines), int(row["line_end"]) + context)
    out_lines = [
        ChunkSourceLine(
            line=i,
            text=all_lines[i - 1] if i - 1 < len(all_lines) else "",
            highlight=row["line_start"] <= i <= row["line_end"],
        )
        for i in range(start, end + 1)
    ]
    return ChunkSourceResponse(
        document_id=str(row["document_id"]),
        document_name=row["document_name"],
        dimension=row["dimension"],
        line_start=int(row["line_start"]),
        line_end=int(row["line_end"]),
        target_line=int(row["line_start"]),
        lines=out_lines,
    )
