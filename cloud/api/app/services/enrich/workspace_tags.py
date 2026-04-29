"""Resolve which tag vocabulary the LLM classifier should use for a
workspace. Order: workspace's own /v1/tags rows → DEFAULT_TAGS fallback.

Centralized here so every enrich entry point (sync run_enrich, cloud_pool
auto-enrich, mcp_pull pending list) classifies against the user's custom
AI tag set rather than the canned 8-tag default.
"""

from __future__ import annotations

from uuid import UUID

from app.common.db import pool
from app.services.enrich.classifier import DEFAULT_TAGS


async def load_workspace_tags(workspace_id: str) -> list[str]:
    async with pool().acquire() as conn:
        rows = await conn.fetch(
            "SELECT name FROM workspace_tags WHERE workspace_id = $1 "
            "ORDER BY sort_order, name",
            UUID(workspace_id),
        )
    names = [r["name"] for r in rows if r["name"]]
    return names or list(DEFAULT_TAGS)
