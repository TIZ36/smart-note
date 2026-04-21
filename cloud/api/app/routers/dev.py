"""Dev-bootstrap endpoint — only available when ALLOW_DEV_BOOTSTRAP=true.

This exists so local dev + CI + the quickstart demo can go from empty DB
to usable tenant/workspace/api-key without standing up Supabase first.
In production (flag off) the endpoint is hidden entirely — FastAPI never
mounts the router.

The endpoint is a "do everything" shortcut: create tenant, create
workspace, create API key with `admin` scope, return the full secret
once. The caller is expected to treat the secret like a password.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from app.db import pool
from app.security import mint_api_key

router = APIRouter(prefix="/v1/dev", tags=["dev"])


@router.post("/bootstrap")
async def bootstrap(body: dict) -> dict:
    tenant_name = (body.get("tenant_name") or "dev").strip()
    workspace_name = (body.get("workspace_name") or "default").strip()
    workspace_slug = (body.get("workspace_slug") or "default").strip().lower()
    key_name = (body.get("api_key_name") or "dev-key").strip()
    if not tenant_name or not workspace_name or not workspace_slug:
        raise HTTPException(400, "tenant_name / workspace_name / workspace_slug required")

    newkey = mint_api_key()
    async with pool().acquire() as conn:
        async with conn.transaction():
            tenant_row = await conn.fetchrow(
                "INSERT INTO tenants(name) VALUES($1) RETURNING id, name, created_at",
                tenant_name,
            )
            workspace_row = await conn.fetchrow(
                "INSERT INTO workspaces(tenant_id, name, slug) "
                "VALUES($1, $2, $3) RETURNING id, tenant_id, name, slug, created_at",
                tenant_row["id"], workspace_name, workspace_slug,
            )
            # Membership row uses a synthetic user_id so subsequent Supabase
            # integration can coexist — real users join later via console.
            await conn.execute(
                "INSERT INTO workspace_members(workspace_id, user_id, role) "
                "VALUES($1, 'dev-bootstrap', 'owner')",
                workspace_row["id"],
            )
            apikey_row = await conn.fetchrow(
                "INSERT INTO api_keys(workspace_id, name, prefix, secret_hash, "
                "  scopes, agent_id, created_by) "
                "VALUES($1, $2, $3, $4, $5, $6, 'dev-bootstrap') "
                "RETURNING id, workspace_id, name, prefix, scopes, agent_id, "
                "          created_at",
                workspace_row["id"], key_name, newkey.prefix, newkey.secret_hash,
                ["admin"], "dev",
            )
    return {
        "tenant": dict(tenant_row),
        "workspace": dict(workspace_row),
        "api_key": {
            **dict(apikey_row),
            # Show the secret ONCE — caller stores it or it's lost.
            "secret": newkey.full_key,
        },
    }
