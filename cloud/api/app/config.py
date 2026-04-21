"""Runtime configuration for the SmartNote Cloud API.

All env var reads go through a single Settings singleton so tests can
override them cleanly (and so nothing else imports os.environ directly).
"""

from __future__ import annotations

from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=None, extra="ignore")

    # ── Database ──────────────────────────────────────────
    # Accepts either sqlalchemy-style (postgresql+asyncpg://…) or raw
    # postgresql://… — we strip the "+asyncpg" suffix since asyncpg
    # doesn't know it.
    database_url: str = Field(default="postgresql://smartnote:smartnote@localhost:5432/smartnote")

    # ── Embedding service ────────────────────────────────
    embed_url: str = Field(default="http://localhost:8009")
    embed_timeout_sec: float = Field(default=10.0)

    # ── JWT (SmartNote-minted, not Supabase) ─────────────
    # Short-lived tokens the SDK swaps API keys for. We sign with HS256 and
    # a single symmetric secret; for multi-instance deploys the secret has
    # to be shared (it's already sensitive; put it in secrets manager).
    jwt_secret: str = Field(default="dev-only-change-me")
    jwt_ttl_seconds: int = Field(default=60 * 60)          # 1 hour
    jwt_issuer: str = Field(default="smartnote-cloud")

    # ── Supabase (auth for console users) ────────────────
    # MVP: the console calls auth/workspace endpoints with a Supabase JWT.
    # The API validates it against this shared JWT secret (HS256 — Supabase
    # default). If unset, Supabase-backed endpoints return 501 so dev mode
    # still works end-to-end.
    supabase_url: str = Field(default="")
    supabase_service_role_key: str = Field(default="")
    supabase_jwt_secret: str = Field(default="")

    # ── Dev bootstrap ─────────────────────────────────────
    # Single-flip env to unlock POST /v1/dev/bootstrap. The endpoint is
    # powerful (mints a full-access API key) so we refuse to expose it
    # in any environment that hasn't opted in.
    allow_dev_bootstrap: bool = Field(default=False)


@lru_cache
def get_settings() -> Settings:
    return Settings()
