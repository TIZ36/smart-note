"""Workspace tag config — `/v1/tags`.

Workspace-level tag definitions (name, description, color, sort).
The classifier uses this list as the allowed tag set when run on
this workspace's documents; the desktop reads it for tag filters
and tree colors.

Locally these lived in tags.json; cloud-side they're rows so they
sync naturally across devices and survive workspace migrations.
"""

from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from app.common.db import pool
from app.deps import Identity, require_scope

router = APIRouter(prefix="/v1/tags", tags=["tags"])


class Tag(BaseModel):
    id: str
    name: str
    description: str = ""
    color: str = "gray"
    sort_order: int = 0


class TagUpsert(BaseModel):
    name: str
    description: str = ""
    color: str = "gray"
    sort_order: int = 0


@router.get(
    "",
    response_model=list[Tag],
    dependencies=[Depends(require_scope("documents:read"))],
)
async def list_tags(
    identity: Identity = Depends(require_scope("documents:read")),
) -> list[Tag]:
    async with pool().acquire() as conn:
        rows = await conn.fetch(
            "SELECT id, name, description, color, sort_order FROM workspace_tags "
            "WHERE workspace_id = $1 ORDER BY sort_order, name",
            UUID(identity.workspace_id),
        )
    return [
        Tag(
            id=str(r["id"]), name=r["name"],
            description=r["description"], color=r["color"],
            sort_order=int(r["sort_order"]),
        )
        for r in rows
    ]


@router.post(
    "",
    response_model=Tag,
    dependencies=[Depends(require_scope("documents:write"))],
)
async def upsert_tag(
    req: TagUpsert,
    identity: Identity = Depends(require_scope("documents:write")),
) -> Tag:
    """Idempotent on (workspace, name) — same-name calls update color/
    description in place rather than duplicating rows."""
    async with pool().acquire() as conn:
        row = await conn.fetchrow(
            """
            INSERT INTO workspace_tags (workspace_id, name, description, color, sort_order)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (workspace_id, name) DO UPDATE
              SET description = EXCLUDED.description,
                  color       = EXCLUDED.color,
                  sort_order  = EXCLUDED.sort_order,
                  updated_at  = now()
            RETURNING id, name, description, color, sort_order
            """,
            UUID(identity.workspace_id), req.name, req.description,
            req.color, req.sort_order,
        )
    return Tag(
        id=str(row["id"]), name=row["name"],
        description=row["description"], color=row["color"],
        sort_order=int(row["sort_order"]),
    )


@router.delete(
    "/{name}",
    dependencies=[Depends(require_scope("documents:write"))],
)
async def delete_tag(
    name: str,
    identity: Identity = Depends(require_scope("documents:write")),
) -> dict:
    async with pool().acquire() as conn:
        result = await conn.execute(
            "DELETE FROM workspace_tags WHERE workspace_id = $1 AND name = $2",
            UUID(identity.workspace_id), name,
        )
    return {"ok": True, "deleted": int(result.rsplit(" ", 1)[-1])}


class TagReorderRequest(BaseModel):
    order: list[str] = Field(description="tag names in desired order")


@router.post(
    "/reorder",
    dependencies=[Depends(require_scope("documents:write"))],
)
async def reorder_tags(
    req: TagReorderRequest,
    identity: Identity = Depends(require_scope("documents:write")),
) -> dict:
    """Reorder tags by name. Tags not in the order list keep their
    existing sort_order (effectively appended)."""
    ws = UUID(identity.workspace_id)
    async with pool().acquire() as conn:
        async with conn.transaction():
            for idx, name in enumerate(req.order):
                await conn.execute(
                    "UPDATE workspace_tags SET sort_order = $3, updated_at = now() "
                    "WHERE workspace_id = $1 AND name = $2",
                    ws, name, idx,
                )
    return {"ok": True, "reordered": len(req.order)}
