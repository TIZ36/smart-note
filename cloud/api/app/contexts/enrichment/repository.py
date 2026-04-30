"""Enrichment context — persistence layer.

Owns reads/writes to: processing_runs (kind='ai_enrich' slice),
workspace_tags, and the `(kind=preference, content=enrich_provider)`
slice of memories.

Today this module still delegates provider lookup to the existing
`app.services.enrich.executors.cloud_pool` helper so the executor and
config route share one credential decoder. As the rest of the
enrichment context migrates, that SQL moves here and the executor calls
this repository instead.

Public functions in this module are the only sanctioned way for
*other* contexts to read enrichment-owned tables — see
ARCHITECTURE.md §1.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional
from uuid import UUID

from app.db import pool


# Re-exported provider config shape. Defined in classifier as
# ProviderConfig; we alias here so callers don't have to know the
# internal module structure.
@dataclass(frozen=True)
class WorkspaceProviderConfig:
    """What the cloud_pool executor needs to talk to one LLM. Snapshot
    of the workspace's stored credential + tuning. `auto_enrich_on_ingest`
    is the policy bit that lets passive sync pushes trigger enrich
    without an explicit caller flag."""

    api_key: str
    base_url: str
    model: str
    timeout_sec: float
    max_tokens: int
    max_concurrency: int
    auto_enrich_on_ingest: bool


@dataclass(frozen=True)
class RecentJob:
    """One row in the console's recent-activity feed. Joined with the
    document so the UI can render `note.txt — done via cloud_pool`
    without a second round-trip."""

    id: str
    status: str
    executor: str | None
    finished_at: str | None
    created_at: str
    document_name: str | None


async def recent_activity(workspace_id: str, limit: int = 5) -> list[RecentJob]:
    """Recent ai_enrich activity — sourced from processing_runs (the
    canonical ledger; enrich_jobs writes were retired)."""
    async with pool().acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT r.id, r.status, r.executor, r.finished_at, r.created_at,
                   d.name AS document_name
            FROM processing_runs r
            LEFT JOIN documents d ON d.id = r.document_id
            WHERE r.workspace_id = $1 AND r.kind = 'ai_enrich'
            ORDER BY COALESCE(r.finished_at, r.created_at) DESC
            LIMIT $2
            """,
            UUID(workspace_id),
            max(1, min(limit, 50)),
        )
    return [
        RecentJob(
            id=str(r["id"]),
            status=r["status"],
            executor=r["executor"],
            finished_at=r["finished_at"].isoformat() if r["finished_at"] else None,
            created_at=r["created_at"].isoformat(),
            document_name=r["document_name"],
        )
        for r in rows
    ]


@dataclass(frozen=True)
class EnrichJobCounts:
    """Status histogram for ai_enrich runs in one workspace. Powers the
    console aggregator and the desktop's enrich-queue card."""

    queued: int
    running: int
    done: int
    failed: int


async def count_for(workspace_id: str) -> EnrichJobCounts:
    """One round-trip status histogram. We aggregate four `FILTER`s
    instead of four full-table scans. Sourced from processing_runs
    filtered to kind='ai_enrich'."""
    async with pool().acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT
              count(*) FILTER (WHERE status = 'queued')  AS queued,
              count(*) FILTER (WHERE status = 'running') AS running,
              count(*) FILTER (WHERE status = 'done')    AS done,
              count(*) FILTER (WHERE status = 'failed')  AS failed
            FROM processing_runs
            WHERE workspace_id = $1 AND kind = 'ai_enrich'
            """,
            UUID(workspace_id),
        )
    return EnrichJobCounts(
        queued=int(row["queued"]),
        running=int(row["running"]),
        done=int(row["done"]),
        failed=int(row["failed"]),
    )


async def get_provider_config(workspace_id: str) -> Optional[WorkspaceProviderConfig]:
    """Return the workspace's saved LLM provider, or None if unset.
    Reads from the memories preference row; the column layout matches
    the legacy `_load_provider` shape so existing executors keep
    working unchanged."""
    # Lazy import so this module stays cheap to import — pulling the
    # cloud_pool module triggers the asyncio + httpx import chain.
    from app.services.enrich.executors.cloud_pool import _load_provider

    raw = await _load_provider(workspace_id)
    if raw is None:
        return None
    return WorkspaceProviderConfig(
        api_key=raw.api_key,
        base_url=raw.base_url,
        model=raw.model,
        timeout_sec=raw.timeout_sec,
        max_tokens=raw.max_tokens,
        max_concurrency=raw.max_concurrency,
        auto_enrich_on_ingest=raw.auto_enrich_on_ingest,
    )
