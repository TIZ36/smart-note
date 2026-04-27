"""Cloud-side ingest — `POST /v1/ingest/document`.

The desktop calls this instead of spawning a local Python pipeline.
Pipeline is parse → chunk → embed → store. AI tag classification is
a separate step (`POST /v1/enrich/run` with executor registry) so
each step can scale + retry independently.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel

from app.deps import Identity, require_scope
from app.services.ingest.pipeline import ingest_document, ingest_run_status

router = APIRouter(prefix="/v1/ingest", tags=["ingest"])


class IngestDocumentRequest(BaseModel):
    document_id: str


class IngestDocumentResponse(BaseModel):
    ingest_run_id: str
    chunk_count: int
    dimension: str
    status: str


@router.post(
    "/document",
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
    "/runs/{run_id}",
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
