"""POST /v1/processing/{document_id}/run — trigger / re-trigger a
processing run.

See docs/processing-pipeline.md §5.2.

Today this router is the single entry-point for explicit run requests
across all `kind` values. Routes that previously enqueued enrichment
through `/v1/enrich/run` will alias through here in a follow-up; for
now this lives alongside.

Scope rules (§6.4):
  - chunk_embed (Phase A)            → documents:write
  - ai_enrich / wiki_abstract, force=False → documents:write
  - ai_enrich / wiki_abstract, force=True  → documents:write + billing
"""

from __future__ import annotations

import asyncio as _asyncio
import logging
from datetime import datetime, timezone
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from app.common import ws_registry
from app.common.db import pool
from app.deps import Identity, current_identity, require_billing_scope, require_scope
from app.services import processing_runs as runs_ledger


def _broadcast(workspace_id: str, payload: dict) -> None:
    """Fire-and-forget WS broadcast. Never raises — pipelines are
    free to call without try/except."""
    payload.setdefault("at", datetime.now(timezone.utc).isoformat())
    try:
        _asyncio.create_task(ws_registry.broadcast(workspace_id, payload))
    except Exception:  # pragma: no cover — defensive, ws_registry shouldn't raise here
        log.exception("processing broadcast failed: %s", payload.get("type"))

log = logging.getLogger(__name__)
router = APIRouter(prefix="/v1/processing", tags=["processing"])


class RecentRun(BaseModel):
    id: str
    document_id: str
    document_name: str | None = None
    kind: str
    status: str
    executor: str | None = None
    error: str | None = None
    revision: int = 0
    created_at: str | None = None
    started_at: str | None = None
    finished_at: str | None = None


@router.get(
    "/recent",
    response_model=list[RecentRun],
    dependencies=[Depends(require_scope("documents:read"))],
)
async def list_recent_runs(
    identity: Identity = Depends(current_identity),
    limit: int = 50,
) -> list[RecentRun]:
    """Workspace-wide recent processing_runs feed for the KP page.
    Joins documents.name so the UI doesn't need a second roundtrip
    per row."""
    limit = max(1, min(int(limit), 200))
    async with pool().acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT r.id, r.document_id, d.name AS document_name,
                   r.kind, r.status, r.executor, r.error, r.revision,
                   r.created_at, r.started_at, r.finished_at
            FROM processing_runs r
            LEFT JOIN documents d ON d.id = r.document_id
            WHERE r.workspace_id = $1
            ORDER BY r.created_at DESC
            LIMIT $2
            """,
            UUID(identity.workspace_id), limit,
        )
    return [
        RecentRun(
            id=str(r["id"]),
            document_id=str(r["document_id"]),
            document_name=r["document_name"],
            kind=r["kind"],
            status=r["status"],
            executor=r["executor"],
            error=r["error"],
            revision=int(r["revision"] or 0),
            created_at=r["created_at"].isoformat() if r["created_at"] else None,
            started_at=r["started_at"].isoformat() if r["started_at"] else None,
            finished_at=r["finished_at"].isoformat() if r["finished_at"] else None,
        )
        for r in rows
    ]

ProcessingKind = Literal["chunk_embed", "ai_enrich", "wiki_abstract"]


class RunRequest(BaseModel):
    kind: ProcessingKind
    # When true, bumps `revision` on the resulting processing_runs row
    # so dedup doesn't suppress a re-run. Always burns LLM tokens for
    # ai_enrich / wiki_abstract; gated by the `billing` scope.
    force: bool = False


class RunResponse(BaseModel):
    run_id: str
    status: str
    dedup_skipped: bool = Field(
        default=False,
        description="True when an existing `done` row was returned "
                    "instead of starting a new run.",
    )
    revision: int = 0


def _kind_costs_money(kind: ProcessingKind) -> bool:
    return kind in ("ai_enrich", "wiki_abstract")


@router.post(
    "/{document_id}/run",
    response_model=RunResponse,
    dependencies=[Depends(require_scope("documents:write"))],
)
async def run_processing(
    document_id: str,
    req: RunRequest,
    identity: Identity = Depends(current_identity),
) -> RunResponse:
    """Single entry-point for triggering processing on a document.

    The function below sketches the wiring; the actual queue insertion
    and dispatcher hand-off lands in P2b-3 / P4-1 once
    `processing_runs` is the canonical progress surface. Today we
    short-circuit `wiki_abstract` to call summarize_document inline so
    the Cloud Console "Generate wiki abstract" button can light up
    without waiting for the full ledger refactor.
    """
    # Billing-scope check for paid kinds when forced. Inline rather
    # than as a route-level Depends so the rule can read the body.
    if req.force and _kind_costs_money(req.kind):
        await require_billing_scope(identity)

    ws = identity.workspace_id

    # Resolve the document; 404 if unknown / cross-workspace.
    async with pool().acquire() as conn:
        doc = await conn.fetchrow(
            "SELECT id, metadata FROM documents WHERE id=$1 AND workspace_id=$2",
            UUID(document_id), UUID(ws),
        )
    if doc is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "document not found")

    if req.kind == "wiki_abstract":
        # Inline execution path — sufficient for v1.2 Phase B and the
        # initial Cloud Console UI. processing_runs is the canonical
        # surface; the legacy enrich_jobs writes were retired with
        # migration 026.
        revision = 1 if req.force else 0
        run_id = await runs_ledger.start(
            workspace_id=ws, document_id=document_id, kind="wiki_abstract",
            revision=revision, executor="wiki_phase_b",
            api_key_id=identity.api_key_id,
        )
        from app.contexts.knowledge.wiki_phase_b import summarize_document
        try:
            result = await summarize_document(ws, document_id)
        except Exception as e:
            log.exception("wiki_phase_b raised for doc %s", document_id)
            await runs_ledger.finish(run_id=run_id, status="failed", error=str(e))
            raise
        if result.get("error"):
            await runs_ledger.finish(
                run_id=run_id, status="failed", error=result["error"],
            )
            raise HTTPException(
                status.HTTP_412_PRECONDITION_FAILED,
                result["error"],
            )
        # Result JSONB carries the per-chapter counts so the Library
        # KN Runs tab can render "12/12 chapters · 0 failed" without
        # a second query.
        final_status = "done" if (result.get("failed") or 0) == 0 else "partial"
        await runs_ledger.finish(
            run_id=run_id, status=final_status, result=result,
        )
        # Tell every connected desktop that this doc's wiki summaries
        # just changed so Library KN view + KP page can refetch /kn
        # without waiting for the user to reload.
        _broadcast(ws, {
            "type": "wiki_abstract_done",
            "document_id": document_id,
            "chapters": int(result.get("chapters") or 0),
            "summarized": int(result.get("summarized") or 0),
            "skipped": int(result.get("skipped") or 0),
            "failed": int(result.get("failed") or 0),
        })
        return RunResponse(
            run_id=str(run_id) if run_id else f"inline:wiki_abstract:{document_id}",
            status=final_status,
            dedup_skipped=result["summarized"] == 0 and result["skipped"] > 0,
            revision=0,
        )

    if req.kind == "chunk_embed":
        # Phase A — re-run the ingest pipeline for the doc. The pipeline
        # is idempotent (DELETE-then-INSERT) so this is safe to call
        # with or without `force`. Dispatch by smartnote_type so wikis
        # go through the chapter splitter.
        from app.contexts.knowledge import service as knowledge
        meta = doc["metadata"] or {}
        if isinstance(meta, str):
            import json as _json
            try: meta = _json.loads(meta)
            except Exception: meta = {}
        snt = meta.get("smartnote_type") if isinstance(meta, dict) else None
        revision = 1 if req.force else 0
        run_id = await runs_ledger.start(
            workspace_id=ws, document_id=document_id, kind="chunk_embed",
            revision=revision, executor="inline",
            api_key_id=identity.api_key_id,
        )
        try:
            ran = await knowledge.ingest_document_for_kind(ws, document_id, snt)
        except Exception as e:
            await runs_ledger.finish(run_id=run_id, status="failed", error=str(e))
            raise
        await runs_ledger.finish(
            run_id=run_id,
            status="done" if ran else "skipped_dedup",
            result={"smartnote_type": snt or "doc", "ran": bool(ran)},
        )
        if ran:
            _broadcast(ws, {
                "type": "chunk_embed_done",
                "document_id": document_id,
                "smartnote_type": snt or "doc",
            })
        return RunResponse(
            run_id=run_id or f"inline:chunk_embed:{document_id}",
            status="done" if ran else "skipped_dedup",
            dedup_skipped=not ran,
            revision=revision,
        )

    if req.kind == "ai_enrich":
        from app.contexts.enrichment import service as enrichment
        revision = 1 if req.force else 0
        run_id = await runs_ledger.start(
            workspace_id=ws, document_id=document_id, kind="ai_enrich",
            revision=revision, executor="dispatcher",
            api_key_id=identity.api_key_id,
        )
        queued = await enrichment.queue_enrich_if_eligible(
            ws, document_id,
            smartnote_type=(doc["metadata"] or {}).get("smartnote_type")
                if isinstance(doc["metadata"], dict) else None,
            force=req.force,
        )
        # Note: ai_enrich is queue-based — terminal status lands in
        # enrich.py:_write_segments_done. The processing_runs row
        # stays `running` until the executor migration teaches that
        # writer to call runs_ledger.finish(). For now skip-cases
        # close out, eligible runs stay open.
        if not queued:
            await runs_ledger.finish(run_id=run_id, status="skipped_dedup")
        if queued:
            _broadcast(ws, {
                "type": "ai_enrich_queued",
                "document_id": document_id,
                "force": bool(req.force),
            })
        return RunResponse(
            run_id=run_id or f"inline:ai_enrich:{document_id}",
            status="done" if queued else "skipped_dedup",
            dedup_skipped=not queued,
            revision=revision,
        )

    # Unreachable per the Literal type, but defensive.
    raise HTTPException(status.HTTP_400_BAD_REQUEST, f"unknown kind: {req.kind}")
