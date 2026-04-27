"""Workspace enrich provider config — `/v1/enrich/provider`.

Read/write the LLM provider config the cloud_pool executor uses to
make concurrent classification calls. Stored as a workspace memory
(kind='preference', content='enrich_provider'); this router is just
a typed surface so the desktop UI doesn't have to know about the
memory storage trick.
"""

from __future__ import annotations

import json
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from app.common.db import pool
from app.deps import Identity, require_scope

router = APIRouter(prefix="/v1/enrich/provider", tags=["enrich"])


class ProviderConfigOut(BaseModel):
    base_url: str
    model: str
    timeout_sec: float
    max_tokens: int
    max_concurrency: int
    has_api_key: bool  # never expose the key itself; just whether it's set
    # When true, /v1/ingest/bulk fires LLM enrich automatically after
    # chunking — same behavior as enrich_with_ai=true on the request.
    # Off by default so accidental "Ingest" clicks don't burn tokens.
    auto_enrich_on_ingest: bool = False


class ProviderConfigUpdate(BaseModel):
    """Partial update — every field optional. Unset fields keep their
    existing value (or fall back to defaults on first save). Lets the
    UI toggle one checkbox without re-submitting model/concurrency."""
    api_key: str | None = None
    base_url: str | None = None
    model: str | None = None
    timeout_sec: float | None = None
    max_tokens: int | None = None
    max_concurrency: int | None = Field(default=None, ge=1, le=512)
    auto_enrich_on_ingest: bool | None = None


@router.get(
    "",
    response_model=ProviderConfigOut,
    dependencies=[Depends(require_scope("documents:read"))],
)
async def get_provider(
    identity: Identity = Depends(require_scope("documents:read")),
) -> ProviderConfigOut:
    async with pool().acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT structured FROM memories
            WHERE workspace_id = $1
              AND kind = 'preference'
              AND content = 'enrich_provider'
              AND status IN ('active', 'draft')
            ORDER BY created_at DESC LIMIT 1
            """,
            UUID(identity.workspace_id),
        )
    if not row:
        return ProviderConfigOut(
            base_url="https://api.openai.com/v1",
            model="gpt-4o-mini",
            timeout_sec=60.0,
            max_tokens=4000,
            max_concurrency=64,
            has_api_key=False,
            auto_enrich_on_ingest=False,
        )
    raw = row["structured"]
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except Exception:
            raw = {}
    raw = raw or {}
    return ProviderConfigOut(
        base_url=raw.get("base_url", "https://api.openai.com/v1"),
        model=raw.get("model", "gpt-4o-mini"),
        timeout_sec=float(raw.get("timeout_sec", 60.0)),
        max_tokens=int(raw.get("max_tokens", 4000)),
        max_concurrency=int(raw.get("max_concurrency", 64)),
        has_api_key=bool(raw.get("api_key")),
        auto_enrich_on_ingest=bool(raw.get("auto_enrich_on_ingest", False)),
    )


@router.put(
    "",
    response_model=ProviderConfigOut,
    dependencies=[Depends(require_scope("documents:write"))],
)
async def put_provider(
    req: ProviderConfigUpdate,
    identity: Identity = Depends(require_scope("documents:write")),
) -> ProviderConfigOut:
    """Upsert the provider config. When api_key is null/empty, keep
    the existing key (so the UI can update model/concurrency without
    re-entering the secret)."""
    ws = UUID(identity.workspace_id)
    async with pool().acquire() as conn:
        prior = await conn.fetchrow(
            """
            SELECT id, structured FROM memories
            WHERE workspace_id = $1 AND kind = 'preference'
              AND content = 'enrich_provider'
              AND status IN ('active', 'draft')
            ORDER BY created_at DESC LIMIT 1
            """,
            ws,
        )

        prior_data: dict = {}
        if prior:
            raw = prior["structured"]
            if isinstance(raw, str):
                try:
                    raw = json.loads(raw)
                except Exception:
                    raw = {}
            prior_data = raw or {}

        api_key = req.api_key if req.api_key else prior_data.get("api_key", "")
        if not api_key:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "api_key is required on first save",
            )
        # Partial update: each field falls back to prior value, then
        # to a typed default. Fresh saves with partial bodies (e.g.
        # toggling auto_enrich_on_ingest only) preserve the rest.
        def _merge(field, default):
            v = getattr(req, field)
            return v if v is not None else prior_data.get(field, default)

        new_payload = {
            "api_key": api_key,
            "base_url": _merge("base_url", "https://api.openai.com/v1"),
            "model": _merge("model", "gpt-4o-mini"),
            "timeout_sec": _merge("timeout_sec", 60.0),
            "max_tokens": _merge("max_tokens", 4000),
            "max_concurrency": _merge("max_concurrency", 64),
            "auto_enrich_on_ingest": _merge("auto_enrich_on_ingest", False),
        }
        # Insert a new memory row (so old config is in the supersede
        # chain for audit). Mark prior as superseded.
        new_row = await conn.fetchrow(
            """
            INSERT INTO memories
                (workspace_id, author_agent, kind, scope, content,
                 structured, pinned, supersedes)
            VALUES ($1, $2, 'preference', 'global', 'enrich_provider',
                    $3::jsonb, true, $4)
            RETURNING id
            """,
            ws, identity.agent_id or "console",
            json.dumps(new_payload),
            prior["id"] if prior else None,
        )
        if prior:
            await conn.execute(
                "UPDATE memories SET status = 'archived' WHERE id = $1",
                prior["id"],
            )
        _ = new_row

    return ProviderConfigOut(
        base_url=new_payload["base_url"],
        model=new_payload["model"],
        timeout_sec=new_payload["timeout_sec"],
        max_tokens=new_payload["max_tokens"],
        max_concurrency=new_payload["max_concurrency"],
        has_api_key=True,
        auto_enrich_on_ingest=new_payload["auto_enrich_on_ingest"],
    )


@router.delete(
    "",
    dependencies=[Depends(require_scope("documents:write"))],
)
async def delete_provider(
    identity: Identity = Depends(require_scope("documents:write")),
) -> dict:
    async with pool().acquire() as conn:
        result = await conn.execute(
            """
            UPDATE memories SET status = 'archived'
            WHERE workspace_id = $1 AND kind = 'preference'
              AND content = 'enrich_provider'
              AND status IN ('active', 'draft')
            """,
            UUID(identity.workspace_id),
        )
    return {"ok": True, "archived": int(result.rsplit(" ", 1)[-1])}
