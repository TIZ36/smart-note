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
import logging
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from app.common.db import pool
from app.deps import Identity, require_scope
from app.services.enrich.classifier import (
    DEFAULT_TAGS,
    ProviderConfig,
    run_classify,
)

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
            "SELECT id, content FROM documents WHERE id = $1 AND workspace_id = $2",
            doc_uuid, ws_uuid,
        )
        if not doc:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "document not found")

        job = await conn.fetchrow(
            """
            INSERT INTO enrich_jobs (workspace_id, document_id, status)
            VALUES ($1, $2, 'queued')
            RETURNING *
            """,
            ws_uuid, doc_uuid,
        )

        if req.provider is None:
            # No provider — leave queued for the Phase 2 dispatcher.
            return _row_to_out(job)

        # Inline BYOK path: run classifier here, write tag_segments,
        # mark job done. This is intentionally synchronous; once the
        # worker pod exists this branch goes away.
        cfg = ProviderConfig(
            api_key=req.provider.api_key,
            base_url=req.provider.base_url,
            model=req.provider.model,
            timeout_sec=req.provider.timeout_sec,
            max_tokens=req.provider.max_tokens,
        )
        await conn.execute(
            "UPDATE enrich_jobs SET status='running', executor='cloud_pool', "
            "dispatched_at=now(), attempts=attempts+1 WHERE id=$1",
            job["id"],
        )

    # Run outside the pool acquire — classify is blocking + slow.
    try:
        lines = (doc["content"] or "").splitlines()
        out = run_classify(lines, cfg, tags=req.tags or DEFAULT_TAGS)
    except Exception as e:
        log.exception("enrich classify failed")
        async with pool().acquire() as conn:
            row = await conn.fetchrow(
                "UPDATE enrich_jobs SET status='failed', error=$2, finished_at=now() "
                "WHERE id=$1 RETURNING *",
                job["id"], str(e),
            )
        return _row_to_out(row)

    async with pool().acquire() as conn:
        async with conn.transaction():
            await conn.execute(
                "DELETE FROM tag_segments WHERE document_id=$1",
                doc_uuid,
            )
            for seg in out.segments:
                await conn.execute(
                    """
                    INSERT INTO tag_segments
                        (workspace_id, document_id, start_line, end_line,
                         tag, confidence, summary, meta)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
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
            row = await conn.fetchrow(
                """
                UPDATE enrich_jobs
                SET status='done', finished_at=now(),
                    result=$2::jsonb
                WHERE id=$1 RETURNING *
                """,
                job["id"],
                json.dumps({
                    "segments": out.segments,
                    "prompt_tokens": out.prompt_tokens,
                    "completion_tokens": out.completion_tokens,
                    "total_tokens": out.total_tokens,
                    "failed_batches": out.failed_batches,
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
