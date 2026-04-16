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

    @property
    def effective_embed_base_url(self) -> str:
        return self.embed_base_url or self.provider_base_url

    @property
    def effective_embed_api_key(self) -> str:
        return self.embed_api_key or self.provider_api_key


settings = Settings()
