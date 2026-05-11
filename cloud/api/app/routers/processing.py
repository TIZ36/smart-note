"""Unified Library processing endpoints.

Every stage uses the same lifecycle and realtime protocol:
create a processing_runs row, emit processing_progress events, write
artefacts, then emit processing_done.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field

from app.deps import Identity, current_identity, require_billing_scope, require_scope
from app.services import processing_runs as runs

log = logging.getLogger(__name__)
router = APIRouter(prefix="/v1/processing", tags=["processing"])

ProcessingKind = Literal[
    "chunk_embed",
    "chunk_enrich",
    "graph_topology",
    "wiki_abstract",
    "note_classify",
]


class RunRequest(BaseModel):
    kind: ProcessingKind
    force: bool = False
    options: dict = Field(default_factory=dict)


class RunResponse(BaseModel):
    run_id: str
    document_id: str
    kind: ProcessingKind
    status: str
    dedup_skipped: bool = False
    revision: int = 0
    result: dict | None = None
    error: dict | str | None = None


class RunListResponse(BaseModel):
    runs: list[dict]


def _kind_costs_money(kind: ProcessingKind) -> bool:
    return kind in ("chunk_enrich", "wiki_abstract", "note_classify")


async def _execute_background(run_id: str) -> None:
    try:
        await runs.execute(run_id)
    except Exception:
        log.exception("processing run failed: %s", run_id)


def _background(run_id: str) -> None:
    asyncio.create_task(_execute_background(run_id))


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
    if req.force and _kind_costs_money(req.kind):
        await require_billing_scope(identity)

    try:
        started = await runs.start(
            workspace_id=identity.workspace_id,
            document_id=document_id,
            kind=req.kind,
            force=req.force,
            options=req.options,
            api_key_id=identity.api_key_id,
        )
    except KeyError:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "document not found")
    except ValueError as exc:
        raise HTTPException(status.HTTP_412_PRECONDITION_FAILED, str(exc))

    if started["dedup_skipped"] or started["status"] in runs.TERMINAL:
        return RunResponse(**started)

    _background(started["run_id"])
    return RunResponse(**started)


@router.get(
    "/runs/{run_id}",
    dependencies=[Depends(require_scope("documents:read"))],
)
async def get_processing_run(
    run_id: str,
    identity: Identity = Depends(current_identity),
) -> dict:
    run = await runs.get_run(run_id, identity.workspace_id)
    if not run:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "run not found")
    return run


@router.get(
    "/runs",
    response_model=RunListResponse,
    dependencies=[Depends(require_scope("documents:read"))],
)
async def list_processing_runs(
    document_id: str | None = None,
    kind: ProcessingKind | None = None,
    status_filter: str | None = Query(default=None, alias="status"),
    limit: int = Query(default=50, ge=1, le=200),
    identity: Identity = Depends(current_identity),
) -> RunListResponse:
    return RunListResponse(
        runs=await runs.list_runs(
            identity.workspace_id,
            document_id=document_id,
            kind=kind,
            status=status_filter,
            limit=limit,
        )
    )


@router.delete(
    "/runs/{run_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(require_scope("documents:write"))],
)
async def cancel_processing_run(
    run_id: str,
    identity: Identity = Depends(current_identity),
) -> None:
    await runs.cancel(run_id, identity.workspace_id)
