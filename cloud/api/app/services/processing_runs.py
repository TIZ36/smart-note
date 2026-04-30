"""Write-through helper for the processing_runs ledger.

Migration 021 added `processing_runs` as the canonical run ledger,
but no producer was wired up — the table sat empty. This module
records every explicit run from `POST /v1/processing/{id}/run`
alongside the existing per-kind surfaces (enrich_jobs, ingest_runs)
so a future PR can flip /kn and KP onto the ledger without losing
historical data.

Scope today is intentionally narrow:
  - non-async input_sha computation (no tag_vocab_sha fanout)
  - ON CONFLICT DO NOTHING via the unique partial index
  - never raises into the request path; failures get logged

The full dedup machinery (carrying tag_vocab + prompt_version into
input_sha so vocabulary edits invalidate cached `done` rows) lands
when the executor migration follows.
"""

from __future__ import annotations

import hashlib
import json
import logging
from typing import Any
from uuid import UUID

from app.common.db import pool

log = logging.getLogger(__name__)


def _input_sha(document_id: str, kind: str, revision: int) -> str:
    """Stable SHA over the minimal dedup tuple. Sufficient for the
    write-through — proper dedup that carries content_sha and tag
    vocab is the executor's job. Documented as "minimal v1" in the
    table comment so consumers don't assume more than what's here."""
    payload = {"document_id": document_id, "kind": kind, "revision": revision}
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


async def start(
    *,
    workspace_id: str,
    document_id: str,
    kind: str,
    revision: int,
    executor: str,
    api_key_id: str | None,
) -> str | None:
    """Insert a `running` row and return its id. Returns None on any
    failure (DB unavailable, conflict on dedup, etc.) — callers must
    treat the run-id as best-effort. The legacy enrich_jobs / inline
    return paths remain authoritative until consumers migrate."""
    sha = _input_sha(document_id, kind, revision)
    try:
        async with pool().acquire() as conn:
            row = await conn.fetchrow(
                """
                INSERT INTO processing_runs (
                  workspace_id, document_id, kind, status, executor,
                  input_sha, input_snapshot, revision,
                  trigger_kind, trigger_ref, started_at
                )
                VALUES ($1, $2, $3, 'running', $4, $5, $6::jsonb, $7,
                        $8, $9, now())
                ON CONFLICT (workspace_id, document_id, kind, input_sha)
                  WHERE status IN ('queued', 'running', 'done')
                  DO NOTHING
                RETURNING id
                """,
                UUID(workspace_id), UUID(document_id), kind, executor,
                sha, json.dumps({"revision": revision, "executor_kind": executor}),
                revision,
                "api_key" if api_key_id else "auto",
                api_key_id or "system",
            )
            if row is None:
                # Conflict — there's already a queued/running/done row
                # with this input_sha. Look it up so the caller gets a
                # stable id back.
                existing = await conn.fetchrow(
                    "SELECT id FROM processing_runs "
                    "WHERE workspace_id=$1 AND document_id=$2 AND kind=$3 "
                    "  AND input_sha=$4 ORDER BY created_at DESC LIMIT 1",
                    UUID(workspace_id), UUID(document_id), kind, sha,
                )
                return str(existing["id"]) if existing else None
            return str(row["id"])
    except Exception as e:
        log.warning("processing_runs.start failed (kind=%s doc=%s): %s",
                    kind, document_id, e)
        return None


async def finish_latest(
    *,
    workspace_id: str,
    document_id: str,
    kind: str,
    status: str,
    result: dict[str, Any] | None = None,
    error: str | None = None,
) -> bool:
    """Close out the most recent non-terminal processing_runs row for
    (workspace_id, document_id, kind). Returns True if a row was
    closed. For workers that don't carry the run_id from the route
    (e.g. enrich.py's _write_segments_done is reached from multiple
    code paths, some of which never went through processing.py).

    Best-effort: a run_id-aware caller should still prefer finish()
    so it touches the exact row it opened.
    """
    try:
        async with pool().acquire() as conn:
            row = await conn.fetchrow(
                """
                UPDATE processing_runs
                SET status      = $4,
                    result      = $5::jsonb,
                    error       = $6,
                    finished_at = now()
                WHERE id = (
                    SELECT id FROM processing_runs
                    WHERE workspace_id = $1
                      AND document_id  = $2
                      AND kind         = $3
                      AND status IN ('queued', 'running')
                    ORDER BY created_at DESC
                    LIMIT 1
                )
                RETURNING id
                """,
                UUID(workspace_id), UUID(document_id), kind, status,
                json.dumps(result) if result is not None else None,
                error,
            )
            return row is not None
    except Exception as e:
        log.warning("processing_runs.finish_latest(kind=%s doc=%s) failed: %s",
                    kind, document_id, e)
        return False


async def finish(
    *,
    run_id: str | None,
    status: str,
    result: dict[str, Any] | None = None,
    error: str | None = None,
) -> None:
    """Mark a run terminal. Tolerates run_id=None so callers can pass
    `await finish(run_id=start(...), ...)` without branching."""
    if run_id is None:
        return
    if status not in ("done", "failed", "partial", "skipped_dedup", "skipped_quota"):
        log.warning("processing_runs.finish: unexpected status %r", status)
    try:
        async with pool().acquire() as conn:
            await conn.execute(
                """
                UPDATE processing_runs
                SET status = $2,
                    result = $3::jsonb,
                    error  = $4,
                    finished_at = now()
                WHERE id = $1
                """,
                UUID(run_id), status,
                json.dumps(result) if result is not None else None,
                error,
            )
    except Exception as e:
        log.warning("processing_runs.finish(id=%s) failed: %s", run_id, e)
