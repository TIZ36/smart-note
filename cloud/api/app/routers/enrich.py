"""Enrich job surface — `POST /v1/enrich/run`, `GET /v1/enrich/jobs`.

Phase 1f: minimal synchronous-or-queued path. The real dispatcher
(executor registry — cc_mcp / ws_relay / cloud_pool) lands in Phase 2.
For now the contract is:

* `POST /v1/enrich/run` with a `document_id` and an inline `provider`
  config runs the classifier on the document's content right here on
  the api pod. Tag segments are written to `tag_segments`. Returns the
  job row.
* `POST /v1/enrich/run` without a provider creates a queued job and
  returns immediately — Phase 2's dispatcher / enrich-worker will pick
  it up.
* `GET /v1/enrich/jobs` lists this workspace's jobs (newest first).

The router is deliberately thin — every business rule lives in
`services/enrich/`. When the dispatcher arrives we just swap the inline
call for `dispatcher.dispatch(job)`.
"""

from __future__ import annotations

import json
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from app.common.db import pool
from app.contexts.enrichment import service as enrichment
from app.deps import Identity, require_scope
from app.services.enrich.classifier import DEFAULT_TAGS, ProviderConfig

router = APIRouter(prefix="/v1/enrich", tags=["enrich"])


class ProviderIn(BaseModel):
    api_key: str
    base_url: str
    model: str
    timeout_sec: float = 60.0
    max_tokens: int = 4000


class EnrichRunRequest(BaseModel):
    document_id: str
    tags: list[str] | None = None
    # When provided, the call runs synchronously on the api pod (BYOK
    # path before the dispatcher exists). When omitted, the job is
    # queued for Phase 2's worker.
    provider: ProviderIn | None = None
    # Override the dispatcher's default executor priority. Useful when
    # the caller wants cloud to do the work directly instead of letting
    # mcp_pull intercept (e.g. full_ingest with AI on, where the user
    # explicitly asked for concurrent server-side LLM calls). Pass
    # ['cloud_pool'] to skip mcp_pull and ws_relay.
    executor_prefs: list[str] | None = None


class EnrichJobOut(BaseModel):
    id: str
    document_id: str
    status: str
    executor: str | None = None
    attempts: int = 0
    result: dict[str, Any] | None = None
    error: str | None = None
    created_at: str
    dispatched_at: str | None = None
    finished_at: str | None = None


def _row_to_out(r) -> EnrichJobOut:
    """Adapt a processing_runs row into the legacy EnrichJobOut shape.
    Wire format is unchanged so existing clients (listEnrichJobs et al.)
    keep working post-cutover. Field mapping:
      run.id           → out.id
      run.started_at   → out.dispatched_at  (the legacy field name was
                                              from the dispatcher era)
    """
    d = dict(r)
    raw = d.get("result")
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except Exception:
            raw = None
    started = d.get("started_at") or d.get("dispatched_at")
    return EnrichJobOut(
        id=str(d["id"]),
        document_id=str(d["document_id"]),
        status=d["status"],
        executor=d.get("executor"),
        attempts=int(d.get("attempts") or 0),
        result=raw,
        error=d.get("error"),
        created_at=d["created_at"].isoformat(),
        dispatched_at=started.isoformat() if started else None,
        finished_at=d["finished_at"].isoformat() if d.get("finished_at") else None,
    )


async def _write_segments_done(
    conn,
    ws_uuid,
    doc_uuid,
    run_id,
    segments,
    executor: str,
    prompt_tokens=0,
    completion_tokens=0,
    total_tokens=0,
):
    """Compatibility shim for MCP submit path; canonical write lives in
    enrichment.service.write_segments_done."""
    await enrichment.write_segments_done(
        conn,
        ws_uuid,
        doc_uuid,
        run_id,
        segments,
        executor,
        prompt_tokens,
        completion_tokens,
        total_tokens,
    )


@router.post(
    "/run",
    response_model=EnrichJobOut,
    dependencies=[Depends(require_scope("documents:write"))],
)
async def run_enrich(
    req: EnrichRunRequest,
    identity: Identity = Depends(require_scope("documents:write")),
) -> EnrichJobOut:
    try:
        run_id = await enrichment.run_enrich(
            workspace_id=identity.workspace_id,
            document_id=req.document_id,
            api_key_id=identity.api_key_id,
            tags=req.tags,
            provider=ProviderConfig(**req.provider.model_dump())
            if req.provider
            else None,
            executor_prefs=list(req.executor_prefs or []),
        )
    except enrichment.EnrichDocumentNotFound:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "document not found")
    except enrichment.EnrichUnsupportedKind as e:
        raise HTTPException(status.HTTP_409_CONFLICT, str(e))
    except enrichment.EnrichmentError as e:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(e))
    return await _read_run_as_job(run_id)


async def _read_run_as_job(run_id: str) -> EnrichJobOut:
    """Fetch the run row + adapt to the legacy EnrichJobOut wire shape.
    Used by routes that need to return a job-like object after the
    underlying state landed in processing_runs."""
    async with pool().acquire() as conn:
        row = await conn.fetchrow(
            "SELECT id, document_id, status, executor, attempts, result, "
            "       error, created_at, started_at, finished_at "
            "FROM processing_runs WHERE id=$1",
            UUID(run_id),
        )
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "run not found")
    return _row_to_out(row)


class PendingJob(BaseModel):
    """A queued job packaged for an external classifier (the cc_mcp
    executor). Carries everything the agent needs to run the LLM call
    without round-tripping back to fetch the document."""

    id: str
    document_id: str
    document_name: str
    content: str
    tags: list[str]
    created_at: str


@router.get(
    "/pending",
    response_model=list[PendingJob],
    dependencies=[Depends(require_scope("documents:write"))],
)
async def list_pending(
    identity: Identity = Depends(require_scope("documents:write")),
    limit: int = 5,
) -> list[PendingJob]:
    """Atomically claim queued ai_enrich rows from processing_runs and
    return them packaged for an agent (the cc_mcp executor path).
    The agent then calls `POST /v1/enrich/jobs/{run_id}/submit` with
    its segments.

    Uses runs_ledger.claim_queued under the hood, which flips status
    to 'running' as part of the SELECT so two pollers can't grab the
    same row. Replaces the legacy enrich_jobs WHERE status='queued'
    poll."""
    from app.services import processing_runs as runs_ledger

    claimed = await runs_ledger.claim_queued(
        workspace_id=identity.workspace_id,
        kind="ai_enrich",
        limit=max(1, min(limit, 50)),
    )
    return [
        PendingJob(
            id=c["id"],
            document_id=c["document_id"],
            document_name=c["document_name"],
            content=c["content"],
            tags=DEFAULT_TAGS,
            created_at=c["created_at"],
        )
        for c in claimed
    ]


class SubmitSegment(BaseModel):
    line_start: int
    line_end: int
    tag: str
    confidence: float = 0.0
    summary: str = ""
    secondary_tags: list[str] = Field(default_factory=list)
    topic_name: str = ""
    keywords: list[str] = Field(default_factory=list)
    entities: list[dict[str, Any]] = Field(default_factory=list)
    is_credential: bool = False


class SubmitRequest(BaseModel):
    segments: list[SubmitSegment]
    executor: str = "mcp_pull"
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0


@router.post(
    "/jobs/{job_id}/submit",
    response_model=EnrichJobOut,
    dependencies=[Depends(require_scope("documents:write"))],
)
async def submit_job(
    job_id: str,
    req: SubmitRequest,
    identity: Identity = Depends(require_scope("documents:write")),
) -> EnrichJobOut:
    """External-classifier callback. Lands segments into tag_segments
    and marks the run done. Idempotent on document_id (replaces existing
    segments for that doc).

    `job_id` here is a processing_runs.id (renamed for backwards-compat
    with the original cc_mcp protocol — the route path still says
    `/jobs/{id}` but the underlying ID space is the canonical ledger)."""
    ws_uuid = UUID(identity.workspace_id)
    run_uuid = UUID(job_id)
    async with pool().acquire() as conn:
        async with conn.transaction():
            run = await conn.fetchrow(
                "SELECT id, document_id, status, kind FROM processing_runs "
                "WHERE id = $1 AND workspace_id = $2 FOR UPDATE",
                run_uuid,
                ws_uuid,
            )
            if not run:
                raise HTTPException(status.HTTP_404_NOT_FOUND, "run not found")
            if run["kind"] != "ai_enrich":
                raise HTTPException(
                    status.HTTP_400_BAD_REQUEST,
                    f"run kind is {run['kind']}, /submit only handles ai_enrich",
                )
            if run["status"] == "done":
                raise HTTPException(status.HTTP_409_CONFLICT, "run already done")
            doc_uuid = run["document_id"]

    # _write_segments_done has its own transaction + closes the run.
    # Pulled out of the SELECT-FOR-UPDATE block to keep the lock scope
    # small (the seg insertion + ledger close don't need the row lock;
    # the caller already validated state above).
    async with pool().acquire() as conn:
        await _write_segments_done(
            conn,
            ws_uuid,
            doc_uuid,
            str(run_uuid),
            [s.model_dump() for s in req.segments],
            req.executor,
            req.prompt_tokens,
            req.completion_tokens,
            req.total_tokens,
        )
    return await _read_run_as_job(str(run_uuid))


@router.get(
    "/jobs",
    response_model=list[EnrichJobOut],
    dependencies=[Depends(require_scope("documents:read"))],
)
async def list_jobs(
    identity: Identity = Depends(require_scope("documents:read")),
    limit: int = 50,
    status_filter: str | None = None,
) -> list[EnrichJobOut]:
    """List ai_enrich runs for the workspace. Wire format unchanged
    from the legacy enrich_jobs surface (clients read EnrichJob[]),
    sourced from processing_runs."""
    ws_uuid = UUID(identity.workspace_id)
    args: list[Any] = [ws_uuid]
    sql = (
        "SELECT id, document_id, status, executor, attempts, result, "
        "       error, created_at, started_at, finished_at "
        "FROM processing_runs "
        "WHERE workspace_id = $1 AND kind = 'ai_enrich'"
    )
    if status_filter:
        args.append(status_filter)
        sql += f" AND status = ${len(args)}"
    args.append(max(1, min(limit, 200)))
    sql += f" ORDER BY created_at DESC LIMIT ${len(args)}"
    async with pool().acquire() as conn:
        rows = await conn.fetch(sql, *args)
    return [_row_to_out(r) for r in rows]


@router.delete(
    "/jobs/{job_id}",
    dependencies=[Depends(require_scope("documents:write"))],
)
async def delete_job(
    job_id: str,
    identity: Identity = Depends(require_scope("documents:write")),
) -> dict:
    """Delete one ai_enrich run (typically used to clear a stuck-queued
    row). Doesn't touch tag_segments / entities written by a prior
    successful run on the same document — those persist independently."""
    async with pool().acquire() as conn:
        result = await conn.execute(
            "DELETE FROM processing_runs "
            "WHERE id = $1 AND workspace_id = $2 AND kind = 'ai_enrich'",
            UUID(job_id),
            UUID(identity.workspace_id),
        )
    return {"ok": True, "deleted": int(result.rsplit(" ", 1)[-1])}


@router.delete(
    "/jobs",
    dependencies=[Depends(require_scope("documents:write"))],
)
async def bulk_delete_jobs(
    identity: Identity = Depends(require_scope("documents:write")),
    status_filter: str | None = None,
) -> dict:
    """Bulk-delete ai_enrich runs, optionally filtered by status. Same
    semantics as the legacy enrich_jobs surface; sourced from
    processing_runs."""
    ws_uuid = UUID(identity.workspace_id)
    args: list[Any] = [ws_uuid]
    sql = "DELETE FROM processing_runs WHERE workspace_id = $1 AND kind = 'ai_enrich'"
    if status_filter:
        args.append(status_filter)
        sql += f" AND status = ${len(args)}"
    async with pool().acquire() as conn:
        result = await conn.execute(sql, *args)
    return {"ok": True, "deleted": int(result.rsplit(" ", 1)[-1])}
