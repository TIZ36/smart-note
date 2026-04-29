"""Cloud search history — `/v1/search/history`.

Mirrors local /search/history so the Search panel's recent-queries
list survives device switches. /v1/chunks/search automatically
appends an entry on every call; this router is just the read +
prune surface.
"""

from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel

from app.common.db import pool
from app.deps import Identity, require_scope

router = APIRouter(prefix="/v1/search/history", tags=["search"])


class SearchHistoryItem(BaseModel):
    id: str
    query_text: str
    result_count: int
    tag_filter: str | None
    created_at: str
    # NULL or 'user' = desktop-driven; agent name like 'Claude Code'
    # = AI CLI search via MCP search_memory.
    author: str | None = None


@router.get(
    "",
    response_model=list[SearchHistoryItem],
    dependencies=[Depends(require_scope("documents:read"))],
)
async def list_history(
    limit: int = Query(default=20, ge=1, le=200),
    identity: Identity = Depends(require_scope("documents:read")),
) -> list[SearchHistoryItem]:
    async with pool().acquire() as conn:
        rows = await conn.fetch(
            "SELECT id, query_text, result_count, tag_filter, created_at, author "
            "FROM search_history WHERE workspace_id = $1 "
            "ORDER BY created_at DESC LIMIT $2",
            UUID(identity.workspace_id), limit,
        )
    return [
        SearchHistoryItem(
            id=str(r["id"]),
            query_text=r["query_text"],
            result_count=int(r["result_count"]),
            tag_filter=r["tag_filter"],
            created_at=r["created_at"].isoformat(),
            author=r.get("author"),
        )
        for r in rows
    ]


@router.delete(
    "/{entry_id}",
    dependencies=[Depends(require_scope("documents:write"))],
)
async def delete_history(
    entry_id: str,
    identity: Identity = Depends(require_scope("documents:write")),
) -> dict:
    async with pool().acquire() as conn:
        await conn.execute(
            "DELETE FROM search_history WHERE id = $1 AND workspace_id = $2",
            UUID(entry_id), UUID(identity.workspace_id),
        )
    return {"ok": True}


@router.delete(
    "",
    dependencies=[Depends(require_scope("documents:write"))],
)
async def clear_history(
    identity: Identity = Depends(require_scope("documents:write")),
) -> dict:
    async with pool().acquire() as conn:
        result = await conn.execute(
            "DELETE FROM search_history WHERE workspace_id = $1",
            UUID(identity.workspace_id),
        )
    return {"ok": True, "deleted": int(result.rsplit(" ", 1)[-1])}


# Internal helper used by /v1/chunks/search to record entries. Kept
# simple — best-effort, swallow errors so a history-write hiccup
# doesn't fail an actual search.
async def record(workspace_id: str, query: str, result_count: int,
                 tag_filter: str | None = None,
                 author: str | None = None) -> None:
    """Best-effort write to search_history. `author` is NULL or
    'user' for desktop-driven searches, an agent name (e.g.
    'Claude Code') for MCP search_memory calls."""
    try:
        async with pool().acquire() as conn:
            await conn.execute(
                "INSERT INTO search_history (workspace_id, query_text, "
                "result_count, tag_filter, author) VALUES ($1, $2, $3, $4, $5)",
                UUID(workspace_id), query[:500], result_count, tag_filter, author,
            )
    except Exception:
        import logging
        logging.getLogger(__name__).debug(
            "search_history record failed (ignored)", exc_info=True,
        )
