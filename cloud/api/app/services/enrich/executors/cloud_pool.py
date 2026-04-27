"""cloud_pool executor — run on the api pod using a workspace-stored key.

The workspace's "pool" key lives in `preferences.enrich_provider`
(JSON: api_key, base_url, model). Only enabled if a paid tier is
attached (¥9.9 / ¥99 / $199); MVP doesn't enforce billing — when the
preference exists, we run.
"""

from __future__ import annotations

import asyncio
import json
import logging
from uuid import UUID

from app.common.db import pool
from app.services.enrich.classifier import (
    DEFAULT_TAGS, ProviderConfig, run_classify,
)
from app.services.enrich.protocols import EnrichJob, EnrichOutcome

kind = "cloud_pool"
log = logging.getLogger(__name__)


async def _load_provider(workspace_id: str) -> ProviderConfig | None:
    """Provider config lives as a `kind='preference'` memory keyed
    `enrich_provider`. The structured payload is the JSON config."""
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
            UUID(workspace_id),
        )
    if not row:
        return None
    raw = row["structured"]
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except Exception:
            return None
    if not isinstance(raw, dict) or not raw.get("api_key"):
        return None
    return ProviderConfig(
        api_key=raw["api_key"],
        base_url=raw.get("base_url", "https://api.openai.com/v1"),
        model=raw.get("model", "gpt-4o-mini"),
        timeout_sec=float(raw.get("timeout_sec", 60.0)),
        max_tokens=int(raw.get("max_tokens", 4000)),
        # User-tunable. 64 default; deepseek users routinely run 256+,
        # OpenAI tier-1 caps lower (~16). Hard ceiling at 512 so a
        # typo can't melt the provider.
        max_concurrency=min(int(raw.get("max_concurrency", 64)), 512),
        auto_enrich_on_ingest=bool(raw.get("auto_enrich_on_ingest", False)),
    )


async def is_available(workspace_id: str) -> bool:
    return await _load_provider(workspace_id) is not None


async def run(job: EnrichJob) -> EnrichOutcome:
    cfg = await _load_provider(job.workspace_id)
    if cfg is None:
        return EnrichOutcome(job.job_id, [], None, error="no pool provider configured")
    lines = (job.content or "").splitlines()
    # classifier is sync + uses ThreadPoolExecutor inside; offload so we
    # don't block the event loop.
    out = await asyncio.to_thread(
        run_classify, lines, cfg, job.tags or DEFAULT_TAGS,
        cfg.max_concurrency,
    )
    return EnrichOutcome(
        job_id=job.job_id,
        segments=out.segments,
        executor="cloud_pool",
        prompt_tokens=out.prompt_tokens,
        completion_tokens=out.completion_tokens,
        total_tokens=out.total_tokens,
    )
