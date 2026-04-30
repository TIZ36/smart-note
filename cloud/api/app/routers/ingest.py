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

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, status
from pydantic import BaseModel, Field

import json as _json
from uuid import UUID

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
    """Single-doc embed pass. Dispatches BY smartnote_type so wiki
    docs go through the chapter splitter (Phase A) and notes go
    through the paragraph chunker. Without this branching, wiki
    docs ended up with chunks but no wiki_chapters rows — and
    "Build wiki abstract" then saw 0 chapters and silently no-op'd.

    Wraps the canonical knowledge.ingest_document_for_kind helper
    + writes to processing_runs + broadcasts chunk_embed_done so
    the desktop's KP page sees this as a normal pipeline run.
    """
    async with pool().acquire() as conn:
        meta_row = await conn.fetchrow(
            "SELECT metadata FROM documents "
            "WHERE id=$1 AND workspace_id=$2",
            UUID(req.document_id), UUID(identity.workspace_id),
        )
    if not meta_row:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "document not found")
    meta = meta_row["metadata"] or {}
    if isinstance(meta, str):
        try:
            meta = _json.loads(meta)
        except Exception:
            meta = {}
    snt = meta.get("smartnote_type") if isinstance(meta, dict) else None

    # Same wiring auto-ingest uses — opens processing_runs row +
    # broadcasts chunk_embed_done on success.
    from app.contexts.knowledge.wiring import _record_and_run
    try:
        await _record_and_run(identity.workspace_id, req.document_id, snt)
    except Exception as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e))

    # Read back what landed so the response shape stays compatible
    # with the original `ingest_document` return.
    async with pool().acquire() as conn:
        row = await conn.fetchrow(
            "SELECT id, chunk_count, status FROM ingest_runs "
            "WHERE workspace_id=$1 AND document_id=$2 "
            "ORDER BY created_at DESC LIMIT 1",
            UUID(identity.workspace_id), UUID(req.document_id),
        )
    return IngestDocumentResponse(
        ingest_run_id=str(row["id"]) if row else "",
        chunk_count=int(row["chunk_count"]) if row else 0,
        dimension=snt or "doc",
        status=(row["status"] if row else "done"),
    )


class BulkIngestRequest(BaseModel):
    document_ids: list[str] = Field(default_factory=list)
    smartnote_type: str | None = None  # filter by metadata.smartnote_type
    topic_prefix: str | None = None    # filter wiki by relative_path prefix
    # Tri-state: True forces enrich, False disables, None reads the
    # workspace's auto_enrich_on_ingest setting (default off).
    enrich_with_ai: bool | None = None


class BulkIngestResponse(BaseModel):
    total: int
    ingested: int
    chunks: int
    failures: list[dict]
    enriched: int = 0
    enrich_failed: int = 0
    enrich_skipped_no_provider: bool = False


@router.post(
    "/ingest/bulk",
    response_model=BulkIngestResponse,
    dependencies=[Depends(require_scope("documents:write"))],
)
async def ingest_bulk(
    req: BulkIngestRequest,
    background_tasks: BackgroundTasks,
    identity: Identity = Depends(require_scope("documents:write")),
) -> BulkIngestResponse:
    """Ingest many documents serially. The pipeline is single-threaded
    on a doc — we don't parallelize because the embed pod is small and
    parallel calls fight the same GPU.

    Selection precedence:
      1. Explicit `document_ids` always run.
      2. `smartnote_type` filter — picks docs of that type.
      3. Neither given — defaults to {note, wiki_topic} (every type
         that's actually chunkable; smart_table / skill skipped).
    """
    ws = UUID(identity.workspace_id)
    target_ids: list[str] = list(req.document_ids)

    # Build the type filter list. Explicit `smartnote_type` wins;
    # otherwise default to the chunkable kinds.
    if req.smartnote_type:
        types_to_query = [req.smartnote_type]
    elif not req.document_ids:
        types_to_query = ["note", "wiki_topic"]
    else:
        types_to_query = []

    for t in types_to_query:
        async with pool().acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT id, metadata FROM documents
                WHERE workspace_id = $1
                  AND (metadata->>'smartnote_type') = $2
                """,
                ws, t,
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
    successfully_ingested: list[str] = []
    # Dispatch BY smartnote_type so wiki docs go through Phase A
    # (chapter splitter) and notes go through paragraph chunking.
    # Same fix as the single-doc /v1/ingest/document route — without
    # this branching, wiki docs in a bulk re-ingest end up with
    # chunks but no wiki_chapters.
    from app.contexts.knowledge.wiring import _record_and_run
    async with pool().acquire() as conn:
        meta_rows = await conn.fetch(
            "SELECT id, metadata FROM documents "
            "WHERE id = ANY($1::uuid[]) AND workspace_id = $2",
            [UUID(d) for d in ordered], UUID(identity.workspace_id),
        )
    snt_by_id: dict[str, str | None] = {}
    for r in meta_rows:
        m = r["metadata"] or {}
        if isinstance(m, str):
            try:
                m = _json.loads(m)
            except Exception:
                m = {}
        snt_by_id[str(r["id"])] = m.get("smartnote_type") if isinstance(m, dict) else None

    for doc_id in ordered:
        try:
            await _record_and_run(
                identity.workspace_id, doc_id, snt_by_id.get(doc_id),
            )
            # Read back the ingest_run row for chunk_count.
            async with pool().acquire() as conn:
                row = await conn.fetchrow(
                    "SELECT chunk_count, status FROM ingest_runs "
                    "WHERE workspace_id=$1 AND document_id=$2 "
                    "ORDER BY created_at DESC LIMIT 1",
                    UUID(identity.workspace_id), UUID(doc_id),
                )
            if row and row["status"] == "done":
                ingested_count += 1
                chunks_total += int(row["chunk_count"] or 0)
                successfully_ingested.append(doc_id)
            else:
                failures.append({
                    "document_id": doc_id,
                    "error": (row and row["status"]) or "no ingest_run row",
                })
        except Exception as e:
            log.exception("bulk ingest failed for %s", doc_id)
            failures.append({"document_id": doc_id, "error": str(e)})

    enrich_skipped_no_provider = False
    enrich_scheduled = 0
    # Resolve tri-state: explicit param wins; otherwise read workspace
    # setting (auto_enrich_on_ingest, default false).
    if req.enrich_with_ai is None:
        from app.services.enrich.executors.cloud_pool import _load_provider
        cfg = await _load_provider(identity.workspace_id)
        do_enrich = bool(cfg and getattr(cfg, "auto_enrich_on_ingest", False))
    else:
        do_enrich = bool(req.enrich_with_ai)

    if do_enrich and successfully_ingested:
        # Pre-check provider config — if missing, surface a clear flag
        # so the UI can prompt "configure provider first" instead of
        # firing 18 jobs that all immediately fail.
        from app.services.enrich.executors.cloud_pool import _load_provider
        cfg = await _load_provider(identity.workspace_id)
        if not cfg:
            enrich_skipped_no_provider = True
            log.info("bulk_ingest: enrich_with_ai requested but no "
                     "provider config — skipping enrich step")
        else:
            # Enrich is fire-and-forget. Each /v1/enrich/run call is
            # synchronous against deepseek/openai (run_classify uses
            # ThreadPoolExecutor for concurrency WITHIN a doc) and can
            # take 30+ seconds for large notes — looping serially in
            # the request handler would block the response well past
            # any reasonable HTTP timeout.
            #
            # Instead: schedule one task per doc via BackgroundTasks.
            # Caller polls /v1/enrich/jobs to see progress. The UI
            # already does this for the Cloud Console "Enrich" tab.
            ws_id = identity.workspace_id
            scope_for_run = identity  # snapshot identity for the task
            for doc_id in successfully_ingested:
                async def _runner(doc_id=doc_id, ws_id=ws_id, identity=scope_for_run):
                    try:
                        from app.routers.enrich import EnrichRunRequest, run_enrich
                        await run_enrich(
                            EnrichRunRequest(
                                document_id=doc_id,
                                executor_prefs=["cloud_pool"],
                            ),
                            identity=identity,
                        )
                    except Exception:
                        log.exception("bg enrich failed for %s", doc_id)
                background_tasks.add_task(_runner)
            enrich_scheduled = len(successfully_ingested)

    return BulkIngestResponse(
        total=len(ordered), ingested=ingested_count,
        chunks=chunks_total, failures=failures,
        enriched=enrich_scheduled,  # treat 'scheduled' as 'will-be-enriched'
        enrich_failed=0,
        enrich_skipped_no_provider=enrich_skipped_no_provider,
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
