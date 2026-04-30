"""Write-through helper for the processing_runs ledger.

Migration 021 added `processing_runs` as the canonical run ledger,
but no producer was wired up — the table sat empty. This module
records every explicit run from `POST /v1/processing/{id}/run`
as the canonical surface for every kind: chunk_embed, ai_enrich,
wiki_abstract. The legacy enrich_jobs table was retired alongside
this; ingest_runs (a separate concept tied to the pre-cloud server)
remains untouched.

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


# Bumped on any structural change to the prompt template / tag vocab
# format. A bump invalidates every cached `done` row so the next
# explicit-run request re-executes against the new prompt. Currently
# v3 to track the wiki Phase B prompt revision; bump together with
# any `_build_prompt` edit in classifier.py / wiki_phase_b.py.
PROMPT_VERSION = "v3"


# Per-kind dedup recipe: which fields participate in input_sha.
#
# chunk_embed   → content_sha invalidates dedup when the doc body
#                 changes (so a re-edit triggers a re-embed)
# ai_enrich     → content_sha + tag_vocab_sha + prompt_version, since
#                 a tag-vocab edit between runs must re-classify
# wiki_abstract → content_sha + prompt_version (chapter splits
#                 derive from body)
def _build_input_sha(*, kind: str, revision: int, snapshot: dict) -> str:
    """SHA over the deterministic snapshot. snapshot keys are sorted +
    json-encoded so rebuilding from the same inputs always yields the
    same digest."""
    payload = {"kind": kind, "revision": revision, **snapshot}
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":"),
                   ensure_ascii=False).encode("utf-8")
    ).hexdigest()


async def _capture_snapshot(
    conn, *, workspace_id: str, document_id: str, kind: str,
) -> dict:
    """Pull just enough state to make input_sha invalidation correct
    for `kind`. Best-effort: any read failure returns {} so we fall
    back to the minimal (doc_id, kind, revision) keying — never block
    a run on snapshot capture.

    Reads are lightweight: documents.content (already in cache for
    most paths) + workspace_tags listing for ai_enrich. No second
    roundtrip needed when the caller has already loaded these — we
    just re-fetch since the writer is the canonical source."""
    snap: dict = {"prompt_version": PROMPT_VERSION}
    try:
        row = await conn.fetchrow(
            "SELECT content FROM documents WHERE id=$1 AND workspace_id=$2",
            UUID(document_id), UUID(workspace_id),
        )
        body = (row["content"] or "") if row else ""
        snap["content_sha"] = hashlib.sha256(body.encode("utf-8")).hexdigest()
    except Exception as e:
        log.warning("snapshot content_sha skipped (doc=%s): %s", document_id, e)
    if kind == "ai_enrich":
        try:
            tag_rows = await conn.fetch(
                "SELECT name FROM workspace_tags WHERE workspace_id=$1 "
                "ORDER BY sort_order, name",
                UUID(workspace_id),
            )
            vocab = [r["name"] for r in tag_rows]
            snap["tag_vocab"] = vocab
            snap["tag_vocab_sha"] = hashlib.sha256(
                json.dumps(vocab, ensure_ascii=False).encode("utf-8")
            ).hexdigest()
        except Exception as e:
            log.warning("snapshot tag_vocab_sha skipped (ws=%s): %s",
                        workspace_id, e)
    return snap


async def start(
    *,
    workspace_id: str,
    document_id: str,
    kind: str,
    revision: int,
    executor: str,
    api_key_id: str | None,
    status: str = "running",
) -> str | None:
    """Insert a `running` row and return its id. Returns None on any
    failure (DB unavailable, conflict on dedup, etc.) — callers must
    treat the run-id as best-effort.

    input_sha is computed over a per-kind snapshot (content_sha for
    every kind; tag_vocab_sha for ai_enrich) so a doc edit or tag
    vocabulary change naturally invalidates a cached `done` row and
    the next request re-runs. Snapshot capture is best-effort — if it
    fails, we fall back to a minimal (doc, kind, revision) key, which
    is still better than nothing."""
    try:
        async with pool().acquire() as conn:
            snapshot = await _capture_snapshot(
                conn, workspace_id=workspace_id,
                document_id=document_id, kind=kind,
            )
            sha = _build_input_sha(
                kind=kind, revision=revision, snapshot=snapshot,
            )
            stored_snapshot = {
                "revision": revision,
                "executor_kind": executor,
                # Store the participating SHAs but not the raw vocab
                # list (that one can be large for big workspaces); the
                # raw body content_sha is enough to reconstruct the
                # invalidation reason when debugging.
                **{k: v for k, v in snapshot.items() if k != "tag_vocab"},
            }
            # `started_at` only set when the row goes straight to
            # 'running'. A 'queued' row hasn't actually started yet —
            # the executor will stamp started_at when it picks up.
            started_at_clause = "now()" if status == "running" else "NULL"
            row = await conn.fetchrow(
                f"""
                INSERT INTO processing_runs (
                  workspace_id, document_id, kind, status, executor,
                  input_sha, input_snapshot, revision,
                  trigger_kind, trigger_ref, started_at
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8,
                        $9, $10, {started_at_clause})
                ON CONFLICT (workspace_id, document_id, kind, input_sha)
                  WHERE status IN ('queued', 'running', 'done')
                  DO NOTHING
                RETURNING id
                """,
                UUID(workspace_id), UUID(document_id), kind, status, executor,
                sha, json.dumps(stored_snapshot, ensure_ascii=False),
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


async def claim_queued(
    *,
    workspace_id: str,
    kind: str,
    limit: int = 5,
) -> list[dict]:
    """Atomically lock + return queued rows for a worker to pick up.
    Replaces the legacy `SELECT FROM enrich_jobs WHERE status='queued'`
    polling that cc_mcp clients did via /v1/enrich/pending.

    Uses FOR UPDATE SKIP LOCKED so two pollers don't grab the same
    row. Status flips to 'running' atomically; started_at stamped.

    Returns list of dicts with id + document context the agent needs
    to actually run the LLM call. Empty list when nothing's queued."""
    async with pool().acquire() as conn:
        rows = await conn.fetch(
            """
            WITH picked AS (
                SELECT id FROM processing_runs
                WHERE workspace_id = $1
                  AND kind = $2
                  AND status = 'queued'
                ORDER BY created_at ASC
                LIMIT $3
                FOR UPDATE SKIP LOCKED
            )
            UPDATE processing_runs r
            SET status = 'running', started_at = now()
            FROM picked p
            WHERE r.id = p.id
            RETURNING r.id, r.document_id, r.created_at
            """,
            UUID(workspace_id), kind, max(1, min(limit, 50)),
        )
        if not rows:
            return []
        # Hydrate with document name + content for the agent.
        ids = [r["document_id"] for r in rows]
        docs = await conn.fetch(
            "SELECT id, name, content FROM documents WHERE id = ANY($1::uuid[])",
            ids,
        )
        doc_by_id = {d["id"]: d for d in docs}
        out = []
        for r in rows:
            d = doc_by_id.get(r["document_id"])
            if d is None:
                # Document deleted between queue + claim. Mark this
                # run failed so it doesn't loop.
                await conn.execute(
                    "UPDATE processing_runs SET status='failed', "
                    "       error='document deleted before pickup', "
                    "       finished_at=now() "
                    "WHERE id=$1",
                    r["id"],
                )
                continue
            out.append({
                "id": str(r["id"]),
                "document_id": str(r["document_id"]),
                "document_name": d["name"],
                "content": d["content"] or "",
                "created_at": r["created_at"].isoformat(),
            })
        return out


async def promote_queued_to_running(*, run_id: str | None) -> bool:
    """Bridge for routes that opened a queued row but ran inline. The
    enrich BYOK / cloud_pool path opens 'queued' (so /pending could
    pick it up if those failed), then runs synchronously when an
    inline executor takes it. Promote to 'running' before the
    finish() so the audit trail records both transitions."""
    if run_id is None:
        return False
    try:
        async with pool().acquire() as conn:
            row = await conn.fetchrow(
                "UPDATE processing_runs SET status='running', "
                "       started_at = COALESCE(started_at, now()) "
                "WHERE id=$1 AND status='queued' RETURNING id",
                UUID(run_id),
            )
            return row is not None
    except Exception as e:
        log.warning("processing_runs.promote_queued_to_running(%s) failed: %s",
                    run_id, e)
        return False


async def sweep_stuck_runs(*, older_than_minutes: int = 30) -> int:
    """Mark `running` rows older than the cutoff as `failed` with a
    timeout error. Necessary because mcp_pull / ws_relay hands ai_enrich
    work to an external agent that may never call back (user closed
    Claude Code, MCP server died, dispatcher dropped the message).
    Without this, those rows stay running forever and downstream
    consumers (Library R-done fallback, KP RecentRunsFeed) misreport
    state.

    Idempotent and safe to call from any pod — uses DB-side `now()`
    so multiple sweepers won't race past each other.

    Returns the number of rows closed."""
    try:
        async with pool().acquire() as conn:
            rows = await conn.fetch(
                """
                UPDATE processing_runs
                SET status      = 'failed',
                    error       = COALESCE(error, '')
                                  || (CASE WHEN error IS NOT NULL AND error <> ''
                                           THEN ' | ' ELSE '' END)
                                  || 'timeout: stuck in running > '
                                  || $1::text || 'min',
                    finished_at = now()
                WHERE status = 'running'
                  AND COALESCE(started_at, created_at)
                      < now() - ($1::text || ' minutes')::interval
                RETURNING id
                """,
                older_than_minutes,
            )
            n = len(rows)
            if n:
                log.warning("processing_runs: swept %d stuck rows (>%dmin)",
                            n, older_than_minutes)
            return n
    except Exception:
        log.exception("processing_runs.sweep_stuck_runs failed")
        return 0


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
