"""mcp_pull executor — leaves the job queued for an MCP-connected agent.

`is_available` is True whenever the workspace has *any* recent MCP tool
call (we treat that as a live always-allow session). Run is a no-op
that signals "queued, will be pulled" — the actual work happens when the
agent calls `list_pending_enrichments` + `submit_enrichments`.
"""

from __future__ import annotations

import time

from app.services.enrich.protocols import EnrichJob, EnrichOutcome

kind = "mcp_pull"

# Workspace ID → last-seen MCP request epoch. Bumped from mcp_http on
# every tool call. Stays in-process for MVP.
_last_seen_mcp: dict[str, float] = {}
_FRESHNESS_SEC = 5 * 60


def mark_active(workspace_id: str) -> None:
    _last_seen_mcp[workspace_id] = time.time()


async def is_available(workspace_id: str) -> bool:
    ts = _last_seen_mcp.get(workspace_id)
    return bool(ts and (time.time() - ts) < _FRESHNESS_SEC)


async def run(job: EnrichJob) -> EnrichOutcome:
    # Don't actually run — leave the job queued for the agent to pull.
    # The router treats executor=None / segments=[] as "stays queued".
    return EnrichOutcome(
        job_id=job.job_id, segments=[], executor=None,
        error=None,
    )
