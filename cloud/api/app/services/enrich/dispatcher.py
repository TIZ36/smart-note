"""Executor Registry — dispatch enrich jobs by priority (decisions E + H).

Priority by default:
  1. mcp_pull   — agent (CC/Cursor) is connected → leave queued, it pulls
  2. ws_relay   — primary device online with BYOK → send over WS
  3. cloud_pool — workspace has paid quota → run on api pod

When none are available the job stays queued. The next /v1/enrich/run
call (or a future cron) re-dispatches.
"""

from __future__ import annotations

import logging

from app.services.enrich.executors import cloud_pool, mcp_pull, ws_relay
from app.services.enrich.protocols import EnrichJob, EnrichOutcome, ExecutorKind

log = logging.getLogger(__name__)

DEFAULT_ORDER: list[ExecutorKind] = ["mcp_pull", "ws_relay", "cloud_pool"]

_REGISTRY = {
    "mcp_pull": mcp_pull,
    "ws_relay": ws_relay,
    "cloud_pool": cloud_pool,
}


async def dispatch(
    job: EnrichJob,
    order: list[ExecutorKind] | None = None,
) -> EnrichOutcome:
    """Try executors in order; return the first outcome (success or
    queued). The router translates `executor=None` into a queued row."""
    chosen = order or job.executor_prefs or DEFAULT_ORDER
    for kind in chosen:
        ex = _REGISTRY.get(kind)
        if ex is None:
            continue
        try:
            if not await ex.is_available(job.workspace_id):
                continue
            log.info("dispatching job=%s via %s", job.job_id, kind)
            return await ex.run(job)
        except Exception as e:
            log.warning("executor %s failed for job=%s: %s", kind, job.job_id, e)
            continue
    return EnrichOutcome(job_id=job.job_id, segments=[], executor=None,
                         error="no executor available")
