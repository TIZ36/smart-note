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
    provider_base_url: str = os.getenv("PROVIDER_BASE_URL", "https://api.openai.com/v1")
    provider_api_key: str = os.getenv("PROVIDER_API_KEY", "")
    provider_chat_model: str = os.getenv("PROVIDER_CHAT_MODEL", "gpt-4o-mini")
    provider_embed_model: str = os.getenv(
        "PROVIDER_EMBED_MODEL", "text-embedding-3-small"
    )
    ingest_ai_enabled: bool = os.getenv("INGEST_AI_ENABLED", "false").lower() in (
        "true",
        "1",
        "yes",
    )
    ingest_ai_model: str = os.getenv("INGEST_AI_MODEL", "")


settings = Settings()
