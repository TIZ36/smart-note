"""API key generation + JWT minting/validation.

Key format: `sn_live_<prefix>_<secret>` where `prefix` is an 8-char
url-safe random string used as the DB lookup index, and `secret` is a
32-char url-safe random string hashed with SHA-256 at rest.

We DON'T use bcrypt/argon2 for secret hashing here because API keys are
machine-generated, high-entropy (~190 bits), and only compared for
equality — a slow hash buys nothing against brute force. Plain SHA-256
keeps exchange latency low.
"""

from __future__ import annotations

import hashlib
import secrets
import time
from dataclasses import dataclass

from jose import JWTError, jwt

from app.config import get_settings


# ── API keys ──────────────────────────────────────────────

@dataclass
class NewApiKey:
    full_key: str       # sn_live_<prefix>_<secret> — returned to user ONCE
    prefix: str
    secret_hash: str    # stored in DB


def mint_api_key() -> NewApiKey:
    # prefix = 12 hex chars (48 bits) — hex guarantees the only '_' in
    # the full key is the secret boundary, which is what parse_api_key
    # relies on. The prefix isn't secret; it's just an indexed lookup
    # key so the server can find the stored hash quickly.
    prefix = secrets.token_hex(6)
    secret = secrets.token_urlsafe(24)
    full = f"sn_live_{prefix}_{secret}"
    return NewApiKey(full_key=full, prefix=prefix, secret_hash=_hash_secret(secret))


def parse_api_key(key: str) -> tuple[str, str] | None:
    """Split a full key into (prefix, secret). Returns None on malformed input.

    Shape: `sn_live_<hex-prefix>_<secret>`. Prefix is hex so the first
    four underscore-separated segments exactly match `sn / live /
    prefix / <everything-else>`; the secret portion may contain '_' or
    '-' since it's base64url.
    """
    parts = key.split("_", 3)
    if len(parts) != 4 or parts[0] != "sn" or parts[1] != "live":
        return None
    prefix, secret = parts[2], parts[3]
    # Defensive: if someone paste-injects a malformed key, catch early.
    if not prefix or not secret:
        return None
    return prefix, secret


def verify_secret(secret: str, stored_hash: str) -> bool:
    return secrets.compare_digest(_hash_secret(secret), stored_hash)


def _hash_secret(secret: str) -> str:
    return hashlib.sha256(secret.encode("utf-8")).hexdigest()


# ── JWTs ──────────────────────────────────────────────────

@dataclass
class TokenClaims:
    api_key_id: str
    workspace_id: str
    scopes: list[str]
    agent_id: str | None


def mint_jwt(claims: TokenClaims) -> tuple[str, int]:
    """Return (token, expires_at_epoch). Signed HS256 with the configured
    symmetric secret. Must match the secret that `verify_jwt` uses."""
    cfg = get_settings()
    now = int(time.time())
    exp = now + cfg.jwt_ttl_seconds
    payload = {
        "sub": claims.api_key_id,
        "ws": claims.workspace_id,
        "scopes": claims.scopes,
        "agent": claims.agent_id or "",
        "iat": now,
        "exp": exp,
        "iss": cfg.jwt_issuer,
    }
    token = jwt.encode(payload, cfg.jwt_secret, algorithm="HS256")
    return token, exp


def verify_jwt(token: str) -> TokenClaims | None:
    cfg = get_settings()
    try:
        payload = jwt.decode(
            token, cfg.jwt_secret, algorithms=["HS256"], issuer=cfg.jwt_issuer
        )
    except JWTError:
        return None
    return TokenClaims(
        api_key_id=payload["sub"],
        workspace_id=payload["ws"],
        scopes=list(payload.get("scopes") or []),
        agent_id=payload.get("agent") or None,
    )
