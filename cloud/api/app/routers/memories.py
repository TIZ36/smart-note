"""Memory CRUD — the heart of the API.

Unified endpoint for every memory kind (fact/preference/procedure/
episode/document_ref). Server embeds on write via the self-hosted embed
service; reads return the full row minus the raw embedding vector (too
bulky + rarely useful to clients).
"""

from __future__ import annotations

from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from app import usage
from app.db import pool
from app.deps import Identity, require_scope
from app.embeddings import embed_one, format_vector_literal

router = APIRouter(prefix="/v1/memories", tags=["memories"])


VALID_KINDS = {"fact", "preference", "procedure", "episode", "document_ref"}


class MemoryCreate(BaseModel):
    kind: str
    content: str
    scope: str = "global"
    structured: dict[str, Any] | None = None
    tags: list[str] = Field(default_factory=list)
    source_refs: list[dict[str, Any]] = Field(default_factory=list)
    confidence: float = 1.0
    pinned: bool = False
    supersedes: str | None = None        # optional explicit supersession


class MemoryPatch(BaseModel):
    # Partial update — only fields explicitly provided are changed.
    # Updating `content` re-embeds. Passing `pinned=False` clears pin, etc.
    content: str | None = None
    scope: str | None = None
    structured: dict[str, Any] | None = None
    tags: list[str] | None = None
    source_refs: list[dict[str, Any]] | None = None
    confidence: float | None = None
    pinned: bool | None = None


class MemoryOut(BaseModel):
    id: str
    workspace_id: str
    author_agent: str
    kind: str
    scope: str
    content: str
    structured: dict[str, Any] | None = None
    tags: list[str]
    source_refs: list[dict[str, Any]]
    confidence: float
    pinned: bool
    supersedes: str | None = None
    created_at: str
    updated_at: str


def _row_to_out(row) -> MemoryOut:
    return MemoryOut(
        id=str(row["id"]),
        workspace_id=str(row["workspace_id"]),
        author_agent=row["author_agent"],
        kind=row["kind"],
        scope=row["scope"],
        content=row["content"],
        structured=row["structured"],
        tags=list(row["tags"] or []),
        source_refs=list(row["source_refs"] or []),
        confidence=float(row["confidence"]),
        pinned=bool(row["pinned"]),
        supersedes=str(row["supersedes"]) if row["supersedes"] else None,
        created_at=row["created_at"].isoformat(),
        updated_at=row["updated_at"].isoformat(),
    )


@router.post(
    "",
    response_model=MemoryOut,
    dependencies=[Depends(require_scope("memories:write"))],
)
async def create_memory(
    req: MemoryCreate,
    identity: Identity = Depends(require_scope("memories:write")),
) -> MemoryOut:
    if req.kind not in VALID_KINDS:
        raise HTTPException(422, f"kind must be one of {sorted(VALID_KINDS)}")

    # Embed at write-time. Failures land as NULL embedding (graceful
    # degradation — see embeddings.py docstring).
    vec = await embed_one(req.content)
    embedding_literal = format_vector_literal(vec) if vec is not None else None

    async with pool().acquire() as conn:
        row = await conn.fetchrow(
            """
            INSERT INTO memories(
              workspace_id, author_agent, kind, scope, content, structured,
              embedding, confidence, pinned, source_refs, tags, supersedes
            ) VALUES (
              $1, $2, $3, $4, $5, $6,
              $7::vector, $8, $9, $10, $11, $12
            )
            RETURNING id, workspace_id, author_agent, kind, scope, content,
                      structured, confidence, pinned, supersedes, source_refs,
                      tags, created_at, updated_at
            """,
            UUID(identity.workspace_id),
            identity.agent_id or "unknown",
            req.kind,
            req.scope,
            req.content,
            req.structured,
            embedding_literal,
            req.confidence,
            req.pinned,
            req.source_refs,
            req.tags,
            UUID(req.supersedes) if req.supersedes else None,
        )
    await usage.bump(identity.workspace_id, memory_delta=1)
    return _row_to_out(row)


@router.patch(
    "/{memory_id}",
    response_model=MemoryOut,
    dependencies=[Depends(require_scope("memories:write"))],
)
async def patch_memory(
    memory_id: str,
    req: MemoryPatch,
    identity: Identity = Depends(require_scope("memories:write")),
) -> MemoryOut:
    # Build the partial update dynamically — only columns the caller
    # explicitly set are touched. We allow swapping `pinned` off, so
    # `.model_dump(exclude_unset=True)` is the right way to detect intent.
    updates = req.model_dump(exclude_unset=True)
    if not updates:
        raise HTTPException(400, "nothing to update")

    sets = ["updated_at = now()"]
    args: list[Any] = []
    for col in ("content", "scope", "structured", "tags", "source_refs",
                "confidence", "pinned"):
        if col in updates:
            args.append(updates[col])
            sets.append(f"{col} = ${len(args)}")

    # Re-embed if content changed.
    if "content" in updates and updates["content"]:
        vec = await embed_one(updates["content"])
        if vec is not None:
            args.append(format_vector_literal(vec))
            sets.append(f"embedding = ${len(args)}::vector")

    args.append(UUID(memory_id))
    mem_id_pos = len(args)
    args.append(UUID(identity.workspace_id))
    ws_id_pos = len(args)

    sql = (
        "UPDATE memories SET " + ", ".join(sets) +
        f" WHERE id = ${mem_id_pos} AND workspace_id = ${ws_id_pos} "
        "RETURNING id, workspace_id, author_agent, kind, scope, content, "
        "          structured, confidence, pinned, supersedes, source_refs, "
        "          tags, created_at, updated_at"
    )
    async with pool().acquire() as conn:
        row = await conn.fetchrow(sql, *args)
    if not row:
        raise HTTPException(404, "memory not found")
    return _row_to_out(row)


@router.get("", dependencies=[Depends(require_scope("memories:read"))])
async def list_memories(
    identity: Identity = Depends(require_scope("memories:read")),
    kind: str | None = Query(default=None),
    scope: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
) -> dict:
    where = ["workspace_id = $1"]
    args: list[Any] = [UUID(identity.workspace_id)]
    if kind:
        args.append(kind); where.append(f"kind = ${len(args)}")
    if scope:
        args.append(scope); where.append(f"scope = ${len(args)}")
    args.append(limit); args.append(offset)
    sql = (
        "SELECT id, workspace_id, author_agent, kind, scope, content, "
        "       structured, confidence, pinned, supersedes, source_refs, "
        "       tags, created_at, updated_at "
        "FROM memories WHERE " + " AND ".join(where) +
        f" ORDER BY created_at DESC LIMIT ${len(args) - 1} OFFSET ${len(args)}"
    )
    async with pool().acquire() as conn:
        rows = await conn.fetch(sql, *args)
    return {"memories": [_row_to_out(r).model_dump() for r in rows]}


@router.get("/{memory_id}", dependencies=[Depends(require_scope("memories:read"))])
async def get_memory(
    memory_id: str,
    identity: Identity = Depends(require_scope("memories:read")),
) -> MemoryOut:
    async with pool().acquire() as conn:
        row = await conn.fetchrow(
            "SELECT id, workspace_id, author_agent, kind, scope, content, "
            "       structured, confidence, pinned, supersedes, source_refs, "
            "       tags, created_at, updated_at "
            "FROM memories WHERE id = $1 AND workspace_id = $2",
            UUID(memory_id), UUID(identity.workspace_id),
        )
    if not row:
        raise HTTPException(404, "memory not found")
    return _row_to_out(row)


@router.delete(
    "/{memory_id}",
    dependencies=[Depends(require_scope("memories:write"))],
)
async def delete_memory(
    memory_id: str,
    identity: Identity = Depends(require_scope("memories:write")),
) -> dict:
    async with pool().acquire() as conn:
        result = await conn.execute(
            "DELETE FROM memories WHERE id = $1 AND workspace_id = $2",
            UUID(memory_id), UUID(identity.workspace_id),
        )
    # asyncpg returns e.g. "DELETE 1" / "DELETE 0"
    deleted = result.endswith(" 1")
    if not deleted:
        raise HTTPException(404, "memory not found")
    await usage.bump(identity.workspace_id, memory_delta=-1)
    return {"deleted": True, "id": memory_id}


