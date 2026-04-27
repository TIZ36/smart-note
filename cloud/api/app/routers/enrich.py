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

import asyncio
import json
import logging
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from app.common.db import pool
from app.deps import Identity, require_scope
from app.services.enrich import dispatcher
from app.services.enrich.classifier import (
    DEFAULT_TAGS,
    ProviderConfig,
    run_classify,
)
from app.services.enrich.protocols import EnrichJob

router = APIRouter(prefix="/v1/enrich", tags=["enrich"])
log = logging.getLogger(__name__)


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
    d = dict(r)
    raw = d.get("result")
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except Exception:
            raw = None
    return EnrichJobOut(
        id=str(d["id"]),
        document_id=str(d["document_id"]),
        status=d["status"],
        executor=d.get("executor"),
        attempts=int(d.get("attempts") or 0),
        result=raw,
        error=d.get("error"),
        created_at=d["created_at"].isoformat(),
        dispatched_at=d["dispatched_at"].isoformat() if d.get("dispatched_at") else None,
        finished_at=d["finished_at"].isoformat() if d.get("finished_at") else None,
    )


async def _write_segments_done(
    conn, ws_uuid, doc_uuid, job_id, segments, executor: str,
    prompt_tokens=0, completion_tokens=0, total_tokens=0,
):
    from app.services.kb.entity_graph import upsert_entities_for_segments
    async with conn.transaction():
        await conn.execute("DELETE FROM tag_segments WHERE document_id=$1", doc_uuid)
        # Re-ingesting clears prior entity_links for this doc's segments
        # by rebuilding from scratch — the fresh segments have new
        # entity sets so any stale edges from the prior run wouldn't
        # belong here. We don't delete `entities` rows themselves
        # (their mention_count is workspace-scoped, not per-doc).
        for seg in segments:
            await conn.execute(
                """
                INSERT INTO tag_segments
                    (workspace_id, document_id, start_line, end_line,
                     tag, confidence, summary, meta)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
                """,
                ws_uuid, doc_uuid,
                int(seg.get("line_start", 0)),
                int(seg.get("line_end", 0)),
                str(seg.get("tag") or "others"),
                float(seg.get("confidence", 0.0)),
                str(seg.get("summary") or ""),
                json.dumps({
                    "secondary_tags": seg.get("secondary_tags", []),
                    "topic_name": seg.get("topic_name", ""),
                    "keywords": seg.get("keywords", []),
                    "entities": seg.get("entities", []),
                    "is_credential": bool(seg.get("is_credential", False)),
                }),
            )
        # Persist entities + co-occurrence edges. Best-effort: if the
        # enrich run somehow returns malformed segments we still want
        # the tag_segments + job-status writes to land.
        try:
            await upsert_entities_for_segments(conn, str(ws_uuid), segments)
        except Exception as e:
            log.warning("entity graph upsert failed for doc %s: %s", doc_uuid, e)
        return await conn.fetchrow(
            """
            UPDATE enrich_jobs
            SET status='done', executor=$2, finished_at=now(),
                dispatched_at=COALESCE(dispatched_at, now()), result=$3::jsonb
            WHERE id=$1 RETURNING *
            """,
            job_id, executor,
            json.dumps({
                "segments": segments,
                "prompt_tokens": prompt_tokens,
                "completion_tokens": completion_tokens,
                "total_tokens": total_tokens,
            }),
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
    ws_uuid = UUID(identity.workspace_id)
    doc_uuid = UUID(req.document_id)

    async with pool().acquire() as conn:
        doc = await conn.fetchrow(
            "SELECT id, content FROM documents WHERE id=$1 AND workspace_id=$2",
            doc_uuid, ws_uuid,
        )
        if not doc:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "document not found")
        job = await conn.fetchrow(
            "INSERT INTO enrich_jobs (workspace_id, document_id, status) "
            "VALUES ($1, $2, 'queued') RETURNING *",
            ws_uuid, doc_uuid,
        )

    # Inline BYOK debug path: provider supplied in request body.
    if req.provider is not None:
        cfg = ProviderConfig(**req.provider.model_dump())
        try:
            lines = (doc["content"] or "").splitlines()
            out = await asyncio.to_thread(
                run_classify, lines, cfg, req.tags or DEFAULT_TAGS,
            )
        except Exception as e:
            log.exception("inline enrich failed")
            async with pool().acquire() as conn:
                row = await conn.fetchrow(
                    "UPDATE enrich_jobs SET status='failed', error=$2, "
                    "finished_at=now() WHERE id=$1 RETURNING *",
                    job["id"], str(e),
                )
            return _row_to_out(row)
        async with pool().acquire() as conn:
            row = await _write_segments_done(
                conn, ws_uuid, doc_uuid, job["id"], out.segments, "cloud_pool",
                out.prompt_tokens, out.completion_tokens, out.total_tokens,
            )
        return _row_to_out(row)

    # Default path: hand to dispatcher (Phase 2 Executor Registry).
    ej = EnrichJob(
        job_id=str(job["id"]),
        workspace_id=identity.workspace_id,
        document_id=str(doc_uuid),
        content=doc["content"] or "",
        tags=req.tags or list(DEFAULT_TAGS),
        executor_prefs=list(req.executor_prefs) if req.executor_prefs else [],
    )
    outcome = await dispatcher.dispatch(ej)
    async with pool().acquire() as conn:
        if outcome.executor and outcome.segments:
            row = await _write_segments_done(
                conn, ws_uuid, doc_uuid, job["id"],
                outcome.segments, outcome.executor,
                outcome.prompt_tokens, outcome.completion_tokens, outcome.total_tokens,
            )
        else:
            # Stays queued — mcp_pull is waiting on the agent, or no
            # executor was available at all.
            row = job
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
    """Return queued jobs an agent can pull and classify with its own
    LLM (the cc_mcp executor path). The agent then calls
    `POST /v1/enrich/jobs/{job_id}/submit` with its segments."""
    ws_uuid = UUID(identity.workspace_id)
    async with pool().acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT j.id, j.document_id, j.created_at, d.name, d.content
            FROM enrich_jobs j
            JOIN documents d ON d.id = j.document_id
            WHERE j.workspace_id = $1 AND j.status = 'queued'
            ORDER BY j.created_at ASC
            LIMIT $2
            """,
            ws_uuid, max(1, min(limit, 50)),
        )
    return [
        PendingJob(
            id=str(r["id"]), document_id=str(r["document_id"]),
            document_name=r["name"], content=r["content"] or "",
            tags=DEFAULT_TAGS,
            created_at=r["created_at"].isoformat(),
        )
        for r in rows
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
    and marks the job done. Idempotent on document_id (replaces existing
    segments for that doc)."""
    ws_uuid = UUID(identity.workspace_id)
    job_uuid = UUID(job_id)
    async with pool().acquire() as conn:
        async with conn.transaction():
            job = await conn.fetchrow(
                "SELECT id, document_id, status FROM enrich_jobs "
                "WHERE id = $1 AND workspace_id = $2 FOR UPDATE",
                job_uuid, ws_uuid,
            )
            if not job:
                raise HTTPException(status.HTTP_404_NOT_FOUND, "job not found")
            if job["status"] in ("done", "cancelled"):
                raise HTTPException(status.HTTP_409_CONFLICT, f"job already {job['status']}")
            doc_uuid = job["document_id"]
            await conn.execute(
                "DELETE FROM tag_segments WHERE document_id=$1", doc_uuid
            )
            for seg in req.segments:
                await conn.execute(
                    """
                    INSERT INTO tag_segments
                        (workspace_id, document_id, start_line, end_line,
                         tag, confidence, summary, meta)
                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
                    """,
                    ws_uuid, doc_uuid, seg.line_start, seg.line_end,
                    seg.tag, seg.confidence, seg.summary,
                    json.dumps({
                        "secondary_tags": seg.secondary_tags,
                        "topic_name": seg.topic_name,
                        "keywords": seg.keywords,
                        "entities": seg.entities,
                        "is_credential": seg.is_credential,
                    }),
                )
            try:
                from app.services.kb.entity_graph import upsert_entities_for_segments
                await upsert_entities_for_segments(
                    conn, str(ws_uuid),
                    [s.model_dump() for s in req.segments],
                )
            except Exception as e:
                log.warning("entity graph upsert (submit_job) failed: %s", e)
            row = await conn.fetchrow(
                """
                UPDATE enrich_jobs
                SET status='done', executor=$2, finished_at=now(),
                    result=$3::jsonb
                WHERE id=$1 RETURNING *
                """,
                job_uuid, req.executor,
                json.dumps({
                    "segments": [s.model_dump() for s in req.segments],
                    "prompt_tokens": req.prompt_tokens,
                    "completion_tokens": req.completion_tokens,
                    "total_tokens": req.total_tokens,
                }),
            )
    return _row_to_out(row)


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
    ws_uuid = UUID(identity.workspace_id)
    args: list[Any] = [ws_uuid]
    sql = "SELECT * FROM enrich_jobs WHERE workspace_id = $1"
    if status_filter:
        args.append(status_filter)
        sql += f" AND status = ${len(args)}"
    args.append(max(1, min(limit, 200)))
    sql += f" ORDER BY created_at DESC LIMIT ${len(args)}"
    async with pool().acquire() as conn:
        rows = await conn.fetch(sql, *args)
    return [_row_to_out(r) for r in rows]
