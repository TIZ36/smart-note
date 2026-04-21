"""FastAPI dependencies — identity extraction + scope checks.

Two bearer-token modes:
  1. SmartNote JWT (sub=api_key_id, ws=workspace_id, scopes=[...]) — the
     normal path agents use after calling /v1/auth/token.
  2. Supabase JWT — used by console users against `/v1/workspaces` etc.
     Identified by `iss` claim not matching our own issuer.

For MVP we only wire (1). Supabase-backed endpoints return 501 until W3
when the console is in play.
"""

from __future__ import annotations

from dataclasses import dataclass

from fastapi import Depends, Header, HTTPException, status

from app.security import TokenClaims, verify_jwt


@dataclass
class Identity:
    api_key_id: str
    workspace_id: str
    scopes: list[str]
    agent_id: str | None

    def has_scope(self, needed: str) -> bool:
        # `admin` is a super-scope that implicitly grants every other scope
        # so we can give a single dev-bootstrap key full reach without
        # enumerating. Per-scope grants stay explicit for real api keys.
        return "admin" in self.scopes or needed in self.scopes


def current_identity(
    authorization: str | None = Header(default=None),
) -> Identity:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "missing bearer token")
    token = authorization.split(" ", 1)[1].strip()
    claims: TokenClaims | None = verify_jwt(token)
    if not claims:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid or expired token")
    return Identity(
        api_key_id=claims.api_key_id,
        workspace_id=claims.workspace_id,
        scopes=claims.scopes,
        agent_id=claims.agent_id,
    )


def require_scope(scope: str):
    """Route dependency: 403 unless the caller's token carries `scope`.

    Use on every endpoint that reads or writes workspace data:
      @router.post(..., dependencies=[Depends(require_scope("memories:write"))])
    """

    def _check(identity: Identity = Depends(current_identity)) -> Identity:
        if not identity.has_scope(scope):
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                f"token is missing required scope: {scope}",
            )
        return identity

    return _check
