"""Workspace + API key CRUD for console users.

Requires Supabase JWT (end-user context). Agents use the api-key → JWT
flow instead (see routers/auth.py).

Scoping:
  - Users can list workspaces they're a member of
  - Creating a workspace makes the caller the owner
  - Only members can issue / revoke API keys

Tenants are created implicitly on first-workspace-create (one tenant per
user at MVP). We'll add multi-workspace-per-tenant in W7 when the console
surfaces team invites.
"""

from __future__ import annotations

from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.db import pool
from app.security import mint_api_key
from app.supabase_auth import SupabaseUser, current_supabase_user

router = APIRouter(prefix="/v1/workspaces", tags=["workspaces"])


class WorkspaceCreate(BaseModel):
    name: str
    slug: str | None = None


class ApiKeyCreate(BaseModel):
    name: str
    scopes: list[str] = Field(default_factory=lambda: ["memories:read", "memories:write", "retrieve"])
    agent_id: str | None = None


@router.get("")
async def list_workspaces(user: SupabaseUser = Depends(current_supabase_user)) -> dict:
    async with pool().acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT w.id, w.tenant_id, w.name, w.slug, w.created_at, wm.role
            FROM workspaces w
            JOIN workspace_members wm ON wm.workspace_id = w.id
            WHERE wm.user_id = $1
            ORDER BY w.created_at DESC
            """,
            user.user_id,
        )
    return {"workspaces": [dict(r) for r in rows]}


@router.post("")
async def create_workspace(
    req: WorkspaceCreate,
    user: SupabaseUser = Depends(current_supabase_user),
) -> dict:
    slug = (req.slug or req.name).strip().lower().replace(" ", "-")
    if not slug:
        raise HTTPException(400, "name or slug required")
    async with pool().acquire() as conn:
        async with conn.transaction():
            # Find or create a tenant for this user. One-per-user for MVP.
            tenant_row = await conn.fetchrow(
                """
                SELECT t.id FROM tenants t
                JOIN workspaces w ON w.tenant_id = t.id
                JOIN workspace_members wm ON wm.workspace_id = w.id
                WHERE wm.user_id = $1
                LIMIT 1
                """,
                user.user_id,
            )
            if tenant_row:
                tenant_id = tenant_row["id"]
            else:
                new_tenant = await conn.fetchrow(
                    "INSERT INTO tenants(name) VALUES($1) RETURNING id",
                    user.email or user.user_id,
                )
                tenant_id = new_tenant["id"]
            ws = await conn.fetchrow(
                "INSERT INTO workspaces(tenant_id, name, slug) "
                "VALUES($1, $2, $3) RETURNING id, tenant_id, name, slug, created_at",
                tenant_id, req.name, slug,
            )
            await conn.execute(
                "INSERT INTO workspace_members(workspace_id, user_id, role) "
                "VALUES($1, $2, 'owner')",
                ws["id"], user.user_id,
            )
    return {"workspace": dict(ws)}


@router.get("/{workspace_id}/api-keys")
async def list_api_keys(
    workspace_id: str,
    user: SupabaseUser = Depends(current_supabase_user),
) -> dict:
    await _require_member(workspace_id, user.user_id)
    async with pool().acquire() as conn:
        rows = await conn.fetch(
            "SELECT id, name, prefix, scopes, agent_id, last_used_at, "
            "revoked_at, created_at "
            "FROM api_keys WHERE workspace_id = $1 ORDER BY created_at DESC",
            UUID(workspace_id),
        )
    return {"api_keys": [dict(r) for r in rows]}


@router.post("/{workspace_id}/api-keys")
async def create_api_key(
    workspace_id: str,
    req: ApiKeyCreate,
    user: SupabaseUser = Depends(current_supabase_user),
) -> dict:
    await _require_member(workspace_id, user.user_id)
    newkey = mint_api_key()
    async with pool().acquire() as conn:
        row = await conn.fetchrow(
            "INSERT INTO api_keys(workspace_id, name, prefix, secret_hash, "
            "  scopes, agent_id, created_by) "
            "VALUES($1, $2, $3, $4, $5, $6, $7) "
            "RETURNING id, workspace_id, name, prefix, scopes, agent_id, "
            "          created_at",
            UUID(workspace_id), req.name, newkey.prefix, newkey.secret_hash,
            req.scopes, req.agent_id, user.user_id,
        )
    return {
        "api_key": {
            **dict(row),
            # Full secret returned ONCE — caller must store it themselves.
            "secret": newkey.full_key,
        },
    }


@router.delete("/{workspace_id}/api-keys/{key_id}")
async def revoke_api_key(
    workspace_id: str,
    key_id: str,
    user: SupabaseUser = Depends(current_supabase_user),
) -> dict:
    await _require_member(workspace_id, user.user_id)
    async with pool().acquire() as conn:
        result = await conn.execute(
            "UPDATE api_keys SET revoked_at = now() "
            "WHERE id = $1 AND workspace_id = $2 AND revoked_at IS NULL",
            UUID(key_id), UUID(workspace_id),
        )
    if not result.endswith(" 1"):
        raise HTTPException(404, "api key not found or already revoked")
    return {"revoked": True, "id": key_id}


async def _require_member(workspace_id: str, user_id: str) -> None:
    async with pool().acquire() as conn:
        row = await conn.fetchrow(
            "SELECT 1 FROM workspace_members "
            "WHERE workspace_id = $1 AND user_id = $2",
            UUID(workspace_id), user_id,
        )
    if not row:
        raise HTTPException(403, "not a member of this workspace")
