"""Console aggregator — `/v1/console/overview`.

Single round-trip the desktop's Cloud Console homepage uses to render
quotas / device status / executor availability / recent activity.
Without this the page would fan out into 6+ requests on tab focus.
"""

from __future__ import annotations

from datetime import datetime, timezone
from uuid import UUID

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from app.common import ws_registry
from app.common.db import pool
from app.contexts.identity.repository import DEVICE_ONLINE_WINDOW_SEC
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
              (SELECT count(*) FROM processing_runs WHERE workspace_id=$1
                                                  AND kind='ai_enrich' AND status='queued') AS enrich_queued,
              (SELECT count(*) FROM processing_runs WHERE workspace_id=$1
                                                  AND kind='ai_enrich' AND status='done')   AS enrich_done,
              (SELECT count(*) FROM memories WHERE workspace_id=$1 AND status='draft')      AS proposals_pending,
              (SELECT count(*) FROM wiki_nodes WHERE workspace_id=$1) AS wiki_nodes
            """,
            ws,
        )
        recent_jobs = await conn.fetch(
            """
            SELECT r.id, r.status, r.executor, r.finished_at, r.created_at, d.name
            FROM processing_runs r JOIN documents d ON d.id = r.document_id
            WHERE r.workspace_id=$1 AND r.kind='ai_enrich'
            ORDER BY COALESCE(r.finished_at, r.created_at) DESC
            LIMIT 5
            """,
            ws,
        )
        # Primary-device heartbeat — same definition as devices.list_devices
        # so the Devices table and the Overview status dot can't disagree.
        primary_last_seen = await conn.fetchval(
            "SELECT last_seen_at FROM devices "
            "WHERE workspace_id = $1 AND is_primary = true",
            ws,
        )

    activity = [
        ActivityItem(
            kind="enrich",
            id=str(r["id"]),
            summary=f"{r['name']} — {r['status']}"
            + (f" via {r['executor']}" if r["executor"] else ""),
            at=(r["finished_at"] or r["created_at"]).isoformat(),
        )
        for r in recent_jobs
    ]

    primary_online = bool(
        primary_last_seen
        and (datetime.now(timezone.utc) - primary_last_seen).total_seconds()
        < DEVICE_ONLINE_WINDOW_SEC
    )

    return OverviewResponse(
        workspace_id=identity.workspace_id,
        counts=Counts(**dict(counts_row)),
        executors=ExecutorStatus(
            mcp_pull=await mcp_pull.is_available(identity.workspace_id),
            # ws_relay executor capability is genuinely WebSocket-bound
            # (it dispatches enrich jobs to a live WS) — leave it on the
            # ws_registry signal. Overview's "WS relay · primary device"
            # dot is asking "is anyone serving enrich jobs?", not "is
            # the primary device on?" — those are different questions.
            ws_relay=ws_registry.has_primary(identity.workspace_id),
            cloud_pool=await cloud_pool.is_available(identity.workspace_id),
        ),
        primary_device_online=primary_online,
        activity=activity,
    )
