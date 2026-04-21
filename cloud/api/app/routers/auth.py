"""Token endpoints — API key → JWT exchange.

MVP keeps this stateless: no refresh_token table, no rolling refresh. The
SDK holds the API key, re-exchanges for a fresh JWT when the current one
is close to expiring. That's "auto-renewal" with minimal moving parts.
Refresh-token mechanics can land in v1.1 when/if we decide to drop the
API key from SDK memory.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.db import pool
from app.security import (
    TokenClaims, mint_jwt, parse_api_key, verify_secret,
)

router = APIRouter(prefix="/v1/auth", tags=["auth"])


class TokenRequest(BaseModel):
    api_key: str


class TokenResponse(BaseModel):
    jwt: str
    expires_at: int              # epoch seconds
    scopes: list[str]
    workspace_id: str
    agent_id: str | None = None


@router.post("/token", response_model=TokenResponse)
async def exchange_token(req: TokenRequest) -> TokenResponse:
    parts = parse_api_key(req.api_key)
    if not parts:
        raise HTTPException(401, "malformed api_key")
    prefix, secret = parts
    async with pool().acquire() as conn:
        row = await conn.fetchrow(
            "SELECT id, workspace_id, secret_hash, scopes, agent_id, revoked_at "
            "FROM api_keys WHERE prefix = $1",
            prefix,
        )
    if not row or row["revoked_at"] is not None:
        raise HTTPException(401, "invalid api_key")
    if not verify_secret(secret, row["secret_hash"]):
        raise HTTPException(401, "invalid api_key")

    # Update last_used_at on a best-effort basis. Don't fail the exchange
    # if this write errors — it's telemetry, not security.
    try:
        async with pool().acquire() as conn:
            await conn.execute(
                "UPDATE api_keys SET last_used_at = now() WHERE id = $1",
                row["id"],
            )
    except Exception:
        pass

    token, exp = mint_jwt(TokenClaims(
        api_key_id=str(row["id"]),
        workspace_id=str(row["workspace_id"]),
        scopes=list(row["scopes"] or []),
        agent_id=row["agent_id"],
    ))
    return TokenResponse(
        jwt=token,
        expires_at=exp,
        scopes=list(row["scopes"] or []),
        workspace_id=str(row["workspace_id"]),
        agent_id=row["agent_id"],
    )
