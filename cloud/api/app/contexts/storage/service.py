"""Storage context — application layer.

Document CRUD still lives in the legacy router for now. This module
exposes the read API that telemetry / console aggregation calls so
those callers never touch the documents table directly.
"""

from __future__ import annotations

from app.contexts.storage.repository import DocumentCounts, count_for as _count_for


async def count_for(workspace_id: str) -> DocumentCounts:
    """Public read accessor. Wrapping the repo func keeps callers
    pinned to the service surface — when document CRUD lifts here
    the call site signatures don't change."""
    return await _count_for(workspace_id)
