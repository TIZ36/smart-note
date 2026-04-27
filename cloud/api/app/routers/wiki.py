"""Wiki node hierarchy router (smartsheet-hybrid via ltree)."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from app.deps import Identity, require_scope
from app.services.kb import wiki_btree

router = APIRouter(prefix="/v1/wiki", tags=["wiki"])


class WikiUpsert(BaseModel):
    path: str
    title: str
    summary: str = ""
    source_ids: list[str] = Field(default_factory=list)
    attrs: dict[str, Any] = Field(default_factory=dict)


class WikiOut(BaseModel):
    id: str
    path: str
    title: str
    summary: str
    source_ids: list[str]
    attrs: dict[str, Any]
    created_at: str
    updated_at: str


def _to_out(n: wiki_btree.WikiNode) -> WikiOut:
    return WikiOut(**n.__dict__)


@router.post("/nodes", response_model=WikiOut,
             dependencies=[Depends(require_scope("documents:write"))])
async def upsert(
    req: WikiUpsert,
    identity: Identity = Depends(require_scope("documents:write")),
) -> WikiOut:
    n = await wiki_btree.upsert_node(
        identity.workspace_id, req.path, req.title,
        req.summary, req.source_ids, req.attrs,
    )
    return _to_out(n)


@router.get("/nodes/{path:path}", response_model=WikiOut,
            dependencies=[Depends(require_scope("documents:read"))])
async def get_one(
    path: str,
    identity: Identity = Depends(require_scope("documents:read")),
) -> WikiOut:
    n = await wiki_btree.get_node(identity.workspace_id, path)
    if not n:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "node not found")
    return _to_out(n)


@router.get("/descendants", response_model=list[WikiOut],
            dependencies=[Depends(require_scope("documents:read"))])
async def list_descendants(
    prefix: str = "root",
    limit: int = 200,
    identity: Identity = Depends(require_scope("documents:read")),
) -> list[WikiOut]:
    rows = await wiki_btree.descendants(identity.workspace_id, prefix, limit)
    return [_to_out(r) for r in rows]


@router.get("/children", response_model=list[WikiOut],
            dependencies=[Depends(require_scope("documents:read"))])
async def list_children(
    parent: str = "root",
    identity: Identity = Depends(require_scope("documents:read")),
) -> list[WikiOut]:
    rows = await wiki_btree.children(identity.workspace_id, parent)
    return [_to_out(r) for r in rows]


class MoveRequest(BaseModel):
    from_prefix: str
    to_prefix: str


@router.post("/move",
             dependencies=[Depends(require_scope("documents:write"))])
async def move(
    req: MoveRequest,
    identity: Identity = Depends(require_scope("documents:write")),
) -> dict[str, int]:
    n = await wiki_btree.move_subtree(
        identity.workspace_id, req.from_prefix, req.to_prefix
    )
    return {"moved": n}


@router.delete("/nodes/{path:path}",
               dependencies=[Depends(require_scope("documents:write"))])
async def delete_path(
    path: str,
    identity: Identity = Depends(require_scope("documents:write")),
) -> dict[str, int]:
    n = await wiki_btree.delete_subtree(identity.workspace_id, path)
    return {"deleted": n}
