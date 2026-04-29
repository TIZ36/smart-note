"""Enrichment context — application layer.

The public entry point other contexts (and routers) call. Owns the
*policy* of enrichment:
  - which docs are eligible (smartnote_type allowlist)
  - whether the workspace has a usable provider
  - whether the workspace's auto-enrich preference is on, and when
    that preference can be bypassed by a `force` flag

Implementation today wraps the legacy router-level `run_enrich` so the
HTTP route, this service, and the event subscriber all funnel through
one classifier path. As the enrichment router migrates to call
`service.run_enrich(...)` directly, the legacy helper goes away.
"""

from __future__ import annotations

import logging

from dataclasses import dataclass

from app.contexts.enrichment.repository import (
    EnrichJobCounts,
    RecentJob,
    WorkspaceProviderConfig,
    count_for as _count_for,
    get_provider_config,
    recent_activity as _recent_activity,
)

log = logging.getLogger(__name__)

# Smartnote types that have a chunkable text body. Mirrors the
# allowlist in knowledge/wiring.py — the two contexts agree on what
# counts as "ingestible". If a third kind earns enrich, both
# allowlists update together.
_ENRICHABLE_KINDS = {"note", "wiki_topic"}


async def count_for(workspace_id: str) -> EnrichJobCounts:
    """Public read accessor for console / telemetry."""
    return await _count_for(workspace_id)


async def recent_activity(workspace_id: str, limit: int = 5) -> list[RecentJob]:
    """Newest-first job list for the console activity feed."""
    return await _recent_activity(workspace_id, limit)


@dataclass(frozen=True)
class ExecutorAvailability:
    """Whether each executor strategy is currently usable. Computed
    on demand — no caching; the answers change as devices connect /
    disconnect and as workspace configs are saved."""
    mcp_pull: bool
    ws_relay: bool
    cloud_pool: bool


async def executors_status(workspace_id: str) -> ExecutorAvailability:
    """Runtime status of the three enrich strategies. mcp_pull /
    cloud_pool ask their executor modules; ws_relay reads the live
    WebSocket registry (a primary device with an open WS can serve
    enrich requests in real time)."""
    # Imported lazily so this service module stays cheap and the
    # executor modules' import-time deps (httpx, asyncio plumbing)
    # don't run unless someone asks for status.
    from app.common import ws_registry
    from app.services.enrich.executors import cloud_pool, mcp_pull
    return ExecutorAvailability(
        mcp_pull=await mcp_pull.is_available(workspace_id),
        ws_relay=ws_registry.has_primary(workspace_id),
        cloud_pool=await cloud_pool.is_available(workspace_id),
    )


async def get_workspace_provider(workspace_id: str) -> WorkspaceProviderConfig | None:
    """Read-only accessor used by the desktop's Cloud Console (via the
    HTTP /v1/enrich/provider route) and by the auto-enrich subscriber.
    Returns None when the workspace hasn't saved an LLM key yet."""
    return await get_provider_config(workspace_id)


async def queue_enrich_if_eligible(
    workspace_id: str, document_id: str, *,
    smartnote_type: str | None,
    force: bool,
) -> bool:
    """Policy + dispatch in one call. Returns True iff a job was
    actually queued.

    Eligibility rules (all must hold):
      1. doc kind is enrichable (note / wiki_topic)
      2. workspace has a saved LLM provider
      3. either `force=True` (caller explicitly opted in — desktop
         "Ingest All" / `full_ingest(enrich_with_ai=True)`)
         OR the workspace's `auto_enrich_on_ingest` preference is on
    """
    if smartnote_type not in _ENRICHABLE_KINDS:
        return False
    cfg = await get_provider_config(workspace_id)
    if cfg is None:
        return False
    if not force and not cfg.auto_enrich_on_ingest:
        return False

    try:
        # Funnel through the existing router-level run_enrich so the
        # HTTP path and event-driven path emit identical job rows.
        # When this context owns its own run_enrich (next refactor
        # pass), the import lands inside repository / classifier
        # directly without going through routers.
        from app.deps import Identity
        from app.routers.enrich import EnrichRunRequest, run_enrich
        ident = Identity(
            api_key_id="auto-ingest",
            workspace_id=workspace_id,
            scopes=["admin"],
            agent_id=None,
        )
        await run_enrich(
            EnrichRunRequest(document_id=document_id, executor_prefs=["cloud_pool"]),
            identity=ident,
        )
        return True
    except Exception:
        log.warning(
            "auto-enrich failed for %s/%s",
            workspace_id, document_id, exc_info=True,
        )
        return False
