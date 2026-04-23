"""Supabase JWT validation for console-side endpoints.

Supabase signs end-user JWTs with a per-project HS256 secret (exposed in
the Supabase dashboard as "JWT Secret"). We verify the same way. Real
production hardening (rotating keys, RS256 support) lands later.

If `supabase_jwt_secret` is unset, `current_supabase_user()` returns 501
so the dev-bootstrap path stays the only way to make workspaces until
the console is wired up.
"""

from __future__ import annotations

from dataclasses import dataclass

from fastapi import Header, HTTPException, status
from jose import JWTError, jwt

from app.config import get_settings


@dataclass
class SupabaseUser:
    user_id: str      # auth.users.id (UUID string)
    email: str | None


def current_supabase_user(
    authorization: str | None = Header(default=None),
) -> SupabaseUser:
    cfg = get_settings()
    if not cfg.supabase_jwt_secret:
        raise HTTPException(
            status.HTTP_501_NOT_IMPLEMENTED,
            "Supabase auth is not configured on this deployment. "
            "Set SUPABASE_JWT_SECRET or use the dev-bootstrap path.",
        )
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "missing bearer token")
    token = authorization.split(" ", 1)[1].strip()
    try:
        payload = jwt.decode(
            token,
            cfg.supabase_jwt_secret,
            algorithms=["HS256"],
            # Supabase JWTs have aud="authenticated" by default; verifying
            # the audience guards against tokens intended for other APIs.
            audience="authenticated",
        )
    except JWTError as e:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, f"invalid token: {e}")
    user_id = payload.get("sub")
    if not user_id:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "token has no subject")
    return SupabaseUser(user_id=user_id, email=payload.get("email"))
