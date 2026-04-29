"""Tiny helpers to merge progress patches into the *_runs JSONB column.

Both ingest_runs and enrich_jobs carry a `progress` jsonb the desktop
polls during long operations. Writers pass any subset of keys; the
update merges (`||`) instead of overwriting so independent phases can
update concurrently without trampling each other.
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


async def set_enrich_progress(job_id: str, **patch) -> None:
    await _merge("enrich_jobs", job_id, patch)


async def set_ingest_progress(run_id: str, **patch) -> None:
    await _merge("ingest_runs", run_id, patch)
