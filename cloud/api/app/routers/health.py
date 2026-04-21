from __future__ import annotations

from fastapi import APIRouter

from app.config import get_settings

router = APIRouter()


@router.get("/v1/health")
def health() -> dict:
    cfg = get_settings()
    return {
        "status": "ok",
        "embed_url": cfg.embed_url,
        "db_configured": bool(cfg.database_url),
        "supabase_configured": bool(cfg.supabase_url),
        "dev_bootstrap_enabled": cfg.allow_dev_bootstrap,
    }
