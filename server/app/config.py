import os
from dataclasses import dataclass

from dotenv import load_dotenv


load_dotenv()


@dataclass
class Settings:
    db_path: str = os.getenv("APP_DB_PATH", "./data/app.db")
    embedding_mode: str = os.getenv("EMBEDDING_MODE", "local")
    local_embed_endpoint: str = os.getenv(
        "LOCAL_EMBED_ENDPOINT", "http://localhost:8009/embed"
    )

    # Chat / AI provider (for chat answers + AI ingestion)
    provider_base_url: str = os.getenv("PROVIDER_BASE_URL", "https://api.openai.com/v1")
    provider_api_key: str = os.getenv("PROVIDER_API_KEY", "")
    provider_chat_model: str = os.getenv("PROVIDER_CHAT_MODEL", "gpt-4o-mini")

    # Embedding provider (separate — can use different provider than chat)
    # Falls back to chat provider if not set
    embed_base_url: str = os.getenv("EMBED_BASE_URL", "")
    embed_api_key: str = os.getenv("EMBED_API_KEY", "")
    provider_embed_model: str = os.getenv(
        "PROVIDER_EMBED_MODEL", "text-embedding-3-small"
    )

    # Master kill switch for ALL LLM calls (ingest enrich, rerank LLM mode,
    # rewrite candidate generation, wiki topic summaries, etc.). When false,
    # the app falls back to non-LLM paths everywhere. Defaults to true so
    # existing installs keep their current behavior.
    ai_features_enabled: bool = os.getenv("AI_FEATURES_ENABLED", "true").lower() in (
        "true",
        "1",
        "yes",
    )

    # AI ingestion
    ingest_ai_enabled: bool = os.getenv("INGEST_AI_ENABLED", "false").lower() in (
        "true",
        "1",
        "yes",
    )
    ingest_ai_model: str = os.getenv("INGEST_AI_MODEL", "")

    # Prompt caching (Anthropic cache_control=ephemeral). Only emits the
    # cache_control block when BOTH the provider looks like Anthropic AND
    # this toggle is on — lets users disable it on proxies that route to
    # Anthropic but reject the field, or on self-hosted deployments. Options:
    #   "auto"  — default, enabled when provider_base_url contains 'anthropic'
    #   "on"    — always emit cache_control (use at your own risk)
    #   "off"   — never emit; concat prefix as plain system text
    prompt_cache_mode: str = os.getenv("PROMPT_CACHE_MODE", "auto").lower()

    # Wiki source files directory (markdown docs ingested from URL/MCP)
    # Default: iCloud Drive ~/sn/source/  — synced across devices
    wiki_sources_dir: str = os.getenv(
        "WIKI_SOURCES_DIR",
        os.path.expanduser("~/Library/Mobile Documents/com~apple~CloudDocs/sn/source"),
    )

    # OCR languages for scanned PDF import (e.g. "chi_sim+eng")
    ocr_langs: str = os.getenv("OCR_LANGS", "")

    # ── SmartNote Cloud sync ─────────────────────────────────────
    # Bidirectional sync of notes / wiki topics / smart tables to a
    # SmartNote Cloud workspace. When enabled, the local gateway pushes
    # local changes to the cloud as `document` entities and pulls any
    # remote changes into local tables. Conflict policy: LWW by
    # updated_at, with the loser snapshot kept in sync_conflicts for
    # manual recovery.
    cloud_sync_enabled: bool = os.getenv("CLOUD_SYNC_ENABLED", "false").lower() in ("true", "1", "yes")
    cloud_sync_url: str = os.getenv("CLOUD_SYNC_URL", "")
    cloud_sync_api_key: str = os.getenv("CLOUD_SYNC_API_KEY", "")

    @property
    def effective_embed_base_url(self) -> str:
        return self.embed_base_url or self.provider_base_url

    @property
    def effective_embed_api_key(self) -> str:
        return self.embed_api_key or self.provider_api_key


settings = Settings()


# ── Runtime-editable settings (persisted in DB) ─────────────────────────────
# These keys can be edited via the Settings UI / POST /settings; changes are
# written to the `app_settings` SQLite table and applied to the singleton in
# place, so consumers doing `from app.config import settings` see new values
# on their next attribute read — no backend restart required.

PERSISTED_KEYS: tuple[str, ...] = (
    "embedding_mode",
    "provider_base_url",
    "provider_api_key",
    "provider_chat_model",
    "embed_base_url",
    "embed_api_key",
    "provider_embed_model",
    "ai_features_enabled",
    "ingest_ai_enabled",
    "ingest_ai_model",
    "prompt_cache_mode",
    "wiki_sources_dir",
    "ocr_langs",
    "cloud_sync_enabled",
    "cloud_sync_url",
    "cloud_sync_api_key",
)

_BOOL_KEYS = {"ai_features_enabled", "ingest_ai_enabled", "cloud_sync_enabled"}


def _coerce(key: str, raw: str):
    if key in _BOOL_KEYS:
        return str(raw).strip().lower() in ("true", "1", "yes")
    return raw


def _serialize(key: str, value) -> str:
    if key in _BOOL_KEYS:
        return "true" if bool(value) else "false"
    return "" if value is None else str(value)


def load_settings_from_db() -> None:
    """Overlay persisted settings onto the in-memory singleton."""
    from app.db import connect  # local import to avoid cycle at module load

    try:
        with connect() as conn:
            rows = conn.execute("SELECT key, value FROM app_settings").fetchall()
    except Exception:
        return
    for row in rows:
        key = row["key"] if hasattr(row, "keys") else row[0]
        val = row["value"] if hasattr(row, "keys") else row[1]
        if key in PERSISTED_KEYS:
            setattr(settings, key, _coerce(key, val))


def seed_settings_if_empty() -> None:
    """First-launch seed: write current env-derived singleton values to DB if
    the table is empty."""
    from app.db import connect

    try:
        with connect() as conn:
            count = conn.execute("SELECT COUNT(*) FROM app_settings").fetchone()[0]
            if count:
                return
            for key in PERSISTED_KEYS:
                conn.execute(
                    "INSERT OR IGNORE INTO app_settings(key, value) VALUES (?, ?)",
                    (key, _serialize(key, getattr(settings, key, ""))),
                )
            conn.commit()
    except Exception:
        pass


def save_settings_to_db(updates: dict) -> dict:
    """Upsert updates into the DB and apply them to the singleton in place.
    Returns the dict of effectively applied values."""
    from app.db import connect

    applied: dict = {}
    with connect() as conn:
        for key, value in updates.items():
            if key not in PERSISTED_KEYS:
                continue
            serialized = _serialize(key, value)
            conn.execute(
                """
                INSERT INTO app_settings(key, value, updated_at)
                VALUES (?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(key) DO UPDATE SET
                  value = excluded.value,
                  updated_at = CURRENT_TIMESTAMP
                """,
                (key, serialized),
            )
            coerced = _coerce(key, serialized)
            setattr(settings, key, coerced)
            applied[key] = coerced
        conn.commit()
    return applied


def current_settings_dict() -> dict:
    return {k: getattr(settings, k, None) for k in PERSISTED_KEYS}
