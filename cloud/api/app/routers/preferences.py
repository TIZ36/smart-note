"""Flat-KV sugar over `memories WHERE kind='preference'`.

One `preference` row per key (enforced at the API layer, not the schema —
easy to relax if we ever want overlapping preferences, e.g. per-project).
On PUT, we supersede any existing row with the same key so the history
stays auditable via the `supersedes` chain.
"""

from __future__ import annotations

from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app import usage
from app.db import pool
from app.deps import Identity, require_scope
from app.embeddings import embed_one, format_vector_literal

router = APIRouter(prefix="/v1/preferences", tags=["preferences"])


class PreferencePut(BaseModel):
    value: Any
    description: str | None = None


@router.get("", dependencies=[Depends(require_scope("memories:read"))])
async def list_preferences(
    identity: Identity = Depends(require_scope("memories:read")),
) -> dict:
    """Return the flat KV snapshot. Superseded rows are filtered out so
    callers always see the "current" value for each key."""
    async with pool().acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT structured, content, updated_at
            FROM memories
            WHERE workspace_id = $1
              AND kind = 'preference'
              AND id NOT IN (
                SELECT supersedes FROM memories
                WHERE workspace_id = $1 AND supersedes IS NOT NULL
              )
            ORDER BY updated_at DESC
            """,
            UUID(identity.workspace_id),
        )
    out: dict[str, Any] = {}
    for r in rows:
        s = r["structured"] or {}
        key = s.get("key")
        if not key:
            continue
        out[key] = {
            "value": s.get("value"),
            "description": s.get("description"),
            "content": r["content"],
            "updated_at": r["updated_at"].isoformat(),
        }
    return {"preferences": out}


@router.get("/{key}", dependencies=[Depends(require_scope("memories:read"))])
async def get_preference(
    key: str,
    identity: Identity = Depends(require_scope("memories:read")),
) -> dict:
    async with pool().acquire() as conn:
        row = await _find_current_pref(conn, identity.workspace_id, key)
    if not row:
        raise HTTPException(404, f"preference not set: {key}")
    s = row["structured"] or {}
    return {
        "key": key,
        "value": s.get("value"),
        "description": s.get("description"),
        "content": row["content"],
        "updated_at": row["updated_at"].isoformat(),
    }


@router.put("/{key}", dependencies=[Depends(require_scope("memories:write"))])
async def put_preference(
    key: str,
    req: PreferencePut,
    identity: Identity = Depends(require_scope("memories:write")),
) -> dict:
    """Set-or-replace. If a preference row with this key already exists,
    the new row `supersedes` it (old row stays for audit)."""
    structured = {
        "key": key,
        "value": req.value,
        "description": req.description,
    }
    # content gets a human-friendly form so retrieve over text works too
    content = f"{key} = {req.value}" + (
        f" ({req.description})" if req.description else ""
    )
    vec = await embed_one(content)
    vec_literal = format_vector_literal(vec) if vec is not None else None

    async with pool().acquire() as conn:
        async with conn.transaction():
            existing = await _find_current_pref(conn, identity.workspace_id, key)
            supersedes_id = existing["id"] if existing else None
            row = await conn.fetchrow(
                """
                INSERT INTO memories(
                  workspace_id, author_agent, kind, scope, content,
                  structured, embedding, supersedes
                ) VALUES (
                  $1, $2, 'preference', 'global', $3, $4, $5::vector, $6
                )
                RETURNING id, structured, updated_at
                """,
                UUID(identity.workspace_id),
                identity.agent_id or "unknown",
                content,
                structured,
                vec_literal,
                supersedes_id,
            )
    if not existing:
        await usage.bump(identity.workspace_id, memory_delta=1)
    return {
        "key": key,
        "value": req.value,
        "description": req.description,
        "memory_id": str(row["id"]),
        "supersedes": str(supersedes_id) if supersedes_id else None,
        "updated_at": row["updated_at"].isoformat(),
    }


@router.delete("/{key}", dependencies=[Depends(require_scope("memories:write"))])
async def delete_preference(
    key: str,
    identity: Identity = Depends(require_scope("memories:write")),
) -> dict:
    """Delete the *current* preference row. History rows (those this row
    supersedes) are intentionally kept — they're the audit trail."""
    async with pool().acquire() as conn:
        row = await _find_current_pref(conn, identity.workspace_id, key)
        if not row:
            raise HTTPException(404, f"preference not set: {key}")
        await conn.execute(
            "DELETE FROM memories WHERE id = $1 AND workspace_id = $2",
            row["id"], UUID(identity.workspace_id),
        )
    return {"deleted": True, "key": key}


async def _find_current_pref(conn, workspace_id: str, key: str):
    return await conn.fetchrow(
        """
        SELECT id, structured, content, updated_at
        FROM memories
        WHERE workspace_id = $1
          AND kind = 'preference'
          AND structured->>'key' = $2
          AND id NOT IN (
            SELECT supersedes FROM memories
            WHERE workspace_id = $1 AND supersedes IS NOT NULL
          )
        ORDER BY updated_at DESC
        LIMIT 1
        """,
        UUID(workspace_id), key,
    )
