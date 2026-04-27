"""Console aggregator — `/v1/console/overview`.

Single round-trip the desktop's Cloud Console homepage uses to render
quotas / device status / executor availability / recent activity.
Without this the page would fan out into 6+ requests on tab focus.
"""

from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from app.common import ws_registry
from app.common.db import pool
from app.deps import Identity, require_scope
from app.services.enrich.executors import cloud_pool, mcp_pull

router = APIRouter(prefix="/v1/console", tags=["console"])


class ExecutorStatus(BaseModel):
    mcp_pull: bool
    ws_relay: bool
    cloud_pool: bool


class Counts(BaseModel):
    memories: int
    documents: int
    devices: int
    enrich_queued: int
    enrich_done: int
    proposals_pending: int
    wiki_nodes: int


class ActivityItem(BaseModel):
    kind: str  # 'enrich' | 'proposal'
    id: str
    summary: str
    at: str


class OverviewResponse(BaseModel):
    workspace_id: str
    counts: Counts
    executors: ExecutorStatus
    primary_device_online: bool
    activity: list[ActivityItem]


@router.get(
    "/overview",
    response_model=OverviewResponse,
    dependencies=[Depends(require_scope("documents:read"))],
)
async def overview(
    identity: Identity = Depends(require_scope("documents:read")),
) -> OverviewResponse:
    ws = UUID(identity.workspace_id)
    async with pool().acquire() as conn:
        counts_row = await conn.fetchrow(
            """
            SELECT
              (SELECT count(*) FROM memories WHERE workspace_id=$1) AS memories,
              (SELECT count(*) FROM documents WHERE workspace_id=$1) AS documents,
              (SELECT count(*) FROM devices   WHERE workspace_id=$1) AS devices,
              (SELECT count(*) FROM enrich_jobs WHERE workspace_id=$1 AND status='queued') AS enrich_queued,
              (SELECT count(*) FROM enrich_jobs WHERE workspace_id=$1 AND status='done')   AS enrich_done,
              (SELECT count(*) FROM memories WHERE workspace_id=$1 AND status='draft')      AS proposals_pending,
              (SELECT count(*) FROM wiki_nodes WHERE workspace_id=$1) AS wiki_nodes
            """,
            ws,
        )
        recent_jobs = await conn.fetch(
            """
            SELECT j.id, j.status, j.executor, j.finished_at, j.created_at, d.name
            FROM enrich_jobs j JOIN documents d ON d.id = j.document_id
            WHERE j.workspace_id=$1
            ORDER BY COALESCE(j.finished_at, j.created_at) DESC
            LIMIT 5
            """,
            ws,
        )

    activity = [
        ActivityItem(
            kind="enrich", id=str(r["id"]),
            summary=f"{r['name']} — {r['status']}"
                    + (f" via {r['executor']}" if r["executor"] else ""),
            at=(r["finished_at"] or r["created_at"]).isoformat(),
        )
        for r in recent_jobs
    ]

    return OverviewResponse(
        workspace_id=identity.workspace_id,
        counts=Counts(**dict(counts_row)),
        executors=ExecutorStatus(
            mcp_pull=await mcp_pull.is_available(identity.workspace_id),
            ws_relay=ws_registry.has_primary(identity.workspace_id),
            cloud_pool=await cloud_pool.is_available(identity.workspace_id),
        ),
        primary_device_online=ws_registry.has_primary(identity.workspace_id),
        activity=activity,
    )
