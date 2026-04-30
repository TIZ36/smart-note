"""SmartNote Cloud API — v1 entrypoint.

On startup: connect to Postgres, run idempotent migrations, mount
routers. The dev-bootstrap router is only mounted when explicitly
enabled via ALLOW_DEV_BOOTSTRAP so production can't stumble into it.
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import get_settings
from app.db import close_pool, init_pool, run_migrations
from app.mcp_http import build_mcp_asgi, mcp as mcp_server
from app.routers import (
    auth,
    console,
    dev,
    devices,
    documents,
    enrich,
    enrich_config,
    graph,
    health,
    ingest,
    memories,
    preferences,
    processing,
    proposals,
    retrieve,
    search_history,
    tags as tags_router,
    usage_route,
    wiki,
    workspaces,
)
from app.contexts.enrichment import wiring as enrichment_wiring
from app.contexts.knowledge import wiring as knowledge_wiring

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s"
)
log = logging.getLogger("smartnote-cloud")

knowledge_wiring.register()
enrichment_wiring.register()


async def _sweep_loop():
    """Background sweeper for processing_runs rows that got handed to
    mcp_pull / ws_relay and never called back. Runs every 5 minutes;
    cutoff is 30 minutes (longest reasonable end-to-end agent latency
    on Phase B). Cheap query — bounded by the partial index on
    (workspace_id, kind, created_at) WHERE status IN ('queued','running')."""
    import asyncio as _asyncio
    from app.services import processing_runs as runs_ledger

    while True:
        try:
            await runs_ledger.sweep_stuck_runs(older_than_minutes=30)
        except Exception:
            log.exception("processing_runs sweeper iteration failed")
        await _asyncio.sleep(300)


@asynccontextmanager
async def lifespan(_: FastAPI):
    import asyncio as _asyncio

    log.info("starting up; connecting to Postgres")
    await init_pool()
    await run_migrations()
    sweeper = _asyncio.create_task(_sweep_loop(), name="processing_runs_sweeper")
    # FastMCP's session manager owns its own anyio task group — it
    # must be entered as part of the app's lifespan or `/mcp` requests
    # explode with "Task group is not initialized".
    async with mcp_server.session_manager.run():
        log.info("ready")
        yield
    sweeper.cancel()
    try:
        await sweeper
    except (Exception, _asyncio.CancelledError):
        pass
    await close_pool()
    log.info("shutdown complete")


app = FastAPI(
    title="SmartNote Cloud API",
    version="0.1.0",
    lifespan=lifespan,
)

# MVP: wide-open CORS so local console + SDK demos "just work". Lock this
# down per-tenant once the real console ships (W7).
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health.router)
app.include_router(auth.router)
# Proposals must register BEFORE memories — it's a subresource at
# /v1/memories/proposals and would otherwise get shadowed by the
# catch-all /v1/memories/{memory_id} route (FastAPI first-match wins,
# and "proposals" would be parsed as a UUID and 422).
app.include_router(proposals.router)
app.include_router(memories.router)
app.include_router(preferences.router)
app.include_router(retrieve.router)
app.include_router(documents.router)
app.include_router(enrich.router)
app.include_router(enrich_config.router)
app.include_router(processing.router)
app.include_router(ingest.router)
app.include_router(graph.router)
app.include_router(search_history.router)
app.include_router(tags_router.router)
app.include_router(wiki.router)
app.include_router(devices.router)
app.include_router(console.router)

from app import ws_relay  # noqa: E402

app.include_router(ws_relay.router)
app.include_router(workspaces.router)
app.include_router(usage_route.router)

# Mount the MCP streamable-HTTP endpoint at /mcp. Clients connect with:
#   url:     https://<host>/mcp
#   headers: Authorization: Bearer sn_live_...
# No local process, no stdio, no absolute paths.
app.mount("/mcp", build_mcp_asgi())

if get_settings().allow_dev_bootstrap:
    log.warning(
        "DEV BOOTSTRAP ENABLED — POST /v1/dev/bootstrap is live. "
        "This is only safe in local dev."
    )
    app.include_router(dev.router)
