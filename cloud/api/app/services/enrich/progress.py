"""Merge progress patches into ingest_runs.progress JSONB.

Used by wiki_processor during the chunking phase so the desktop
polling /v1/ingest/runs/{id} sees phase transitions live. Writers
pass any subset of keys; the update merges (`||`) instead of
overwriting so independent phases can update concurrently without
trampling each other.

(The enrich_jobs progress helper was dropped alongside the table
in migration 026 — that pipeline now uses processing_runs.result
for terminal-state results and the WS broadcast stream for
intermediate progress.)
"""

from __future__ import annotations

import json
from uuid import UUID

from app.common.db import pool


async def _merge(table: str, row_id: str, patch: dict) -> None:
    if not patch:
        return
    async with pool().acquire() as conn:
        await conn.execute(
            f"UPDATE {table} SET progress = COALESCE(progress, '{{}}'::jsonb) "
            f"|| $2::jsonb WHERE id = $1",
            UUID(row_id), json.dumps(patch),
        )


async def set_ingest_progress(run_id: str, **patch) -> None:
    await _merge("ingest_runs", run_id, patch)
