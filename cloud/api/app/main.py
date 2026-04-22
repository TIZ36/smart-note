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
    auth, dev, documents, health, memories, preferences, proposals,
    retrieve, usage_route, workspaces,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("smartnote-cloud")


@asynccontextmanager
async def lifespan(_: FastAPI):
    log.info("starting up; connecting to Postgres")
    await init_pool()
    await run_migrations()
    # FastMCP's session manager owns its own anyio task group — it
    # must be entered as part of the app's lifespan or `/mcp` requests
    # explode with "Task group is not initialized".
    async with mcp_server.session_manager.run():
        log.info("ready")
        yield
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
