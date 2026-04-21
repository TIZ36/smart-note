"""Per-workspace usage counters.

Pure metering at MVP — no enforcement. Every write/retrieve path calls
`bump()` which upserts both the running total and the current-month row.
Errors inside bump() are swallowed: a counter that falls behind is less
bad than a counter failure bringing down a real write.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from uuid import UUID

from app.db import pool

log = logging.getLogger(__name__)


async def bump(
    workspace_id: str | UUID,
    *,
    memory_delta: int = 0,
    document_delta: int = 0,
    embed_tokens: int = 0,
    retrieve_delta: int = 0,
) -> None:
    wid = UUID(workspace_id) if isinstance(workspace_id, str) else workspace_id
    month = datetime.now(timezone.utc).strftime("%Y-%m")
    try:
        async with pool().acquire() as conn:
            async with conn.transaction():
                await conn.execute(
                    """
                    INSERT INTO workspace_usage(
                      workspace_id, memory_count, document_count,
                      embed_tokens, retrieve_calls
                    ) VALUES ($1, $2, $3, $4, $5)
                    ON CONFLICT (workspace_id) DO UPDATE SET
                      memory_count    = workspace_usage.memory_count   + EXCLUDED.memory_count,
                      document_count  = workspace_usage.document_count + EXCLUDED.document_count,
                      embed_tokens    = workspace_usage.embed_tokens   + EXCLUDED.embed_tokens,
                      retrieve_calls  = workspace_usage.retrieve_calls + EXCLUDED.retrieve_calls,
                      updated_at      = now()
                    """,
                    wid, memory_delta, document_delta, embed_tokens, retrieve_delta,
                )
                await conn.execute(
                    """
                    INSERT INTO workspace_usage_monthly(
                      workspace_id, month, memory_count, embed_tokens, retrieve_calls
                    ) VALUES ($1, $2, $3, $4, $5)
                    ON CONFLICT (workspace_id, month) DO UPDATE SET
                      memory_count   = workspace_usage_monthly.memory_count   + EXCLUDED.memory_count,
                      embed_tokens   = workspace_usage_monthly.embed_tokens   + EXCLUDED.embed_tokens,
                      retrieve_calls = workspace_usage_monthly.retrieve_calls + EXCLUDED.retrieve_calls,
                      updated_at     = now()
                    """,
                    wid, month, memory_delta, embed_tokens, retrieve_delta,
                )
    except Exception as e:
        log.warning("usage.bump failed (non-fatal): %s", e)


async def get(workspace_id: str | UUID) -> dict:
    wid = UUID(workspace_id) if isinstance(workspace_id, str) else workspace_id
    async with pool().acquire() as conn:
        row = await conn.fetchrow(
            "SELECT memory_count, document_count, embed_tokens, retrieve_calls, "
            "updated_at FROM workspace_usage WHERE workspace_id = $1",
            wid,
        )
    if not row:
        return {
            "memory_count": 0, "document_count": 0,
            "embed_tokens": 0, "retrieve_calls": 0,
        }
    return {
        "memory_count": row["memory_count"],
        "document_count": row["document_count"],
        "embed_tokens": row["embed_tokens"],
        "retrieve_calls": row["retrieve_calls"],
        "updated_at": row["updated_at"].isoformat(),
    }
