"""Knowledge context — event subscriptions.

Reacts to document lifecycle events from storage. Wiring is the only
place knowledge talks to the event bus; chunk+embed and cleanup
policy live in service.py.
"""

from __future__ import annotations

import asyncio
import logging

from app.contexts.knowledge import service
from app.contexts.storage.events import (
    DocumentContentChanged,
    DocumentCreated,
    DocumentDeleted,
)
from app.infra import events
from app.services import processing_runs

log = logging.getLogger(__name__)

# Same allowlist as service._INGEST_KINDS — kinds with no chunkable
# content skip the chunk_embed run entirely (would just produce a
# failed row otherwise).
_AUTO_INGEST_KINDS = {"note", "wiki_topic"}


async def _auto_ingest(
    workspace_id: str, document_id: str, smartnote_type: str | None
) -> None:
    """Auto-ingest a freshly created / content-changed document through
    the normal processing_runs lifecycle (not a bare
    service.ingest_document_for_kind call). Same execution under the
    hood — but creates a processing_runs row so:
      - Library left-tree chips see the run via listRecentRuns
      - processing_progress / processing_done events carry the
        canonical run_id the desktop's useBulkRuns map keys on
      - the run shows up in the doc's Pipeline card alongside
        user-triggered runs

    Prior to this, auto-ingest went directly through service.* and
    left no audit trail, so the chip stayed grey forever even though
    chunks were live in the DB. (Wiki worked in some cases only
    because the user clicked Re-embed in the Library, which DID go
    through processing_runs.)

    Dedup: processing_runs.start hashes the input snapshot
    (content_sha + workspace tag vocab + kind), so re-firing
    DocumentContentChanged after a no-op edit won't queue a duplicate
    embed run."""
    if smartnote_type not in _AUTO_INGEST_KINDS:
        return
    await _start_auto_ingest(workspace_id, document_id)


async def _start_auto_ingest(workspace_id: str, document_id: str) -> None:
    try:
        started = await processing_runs.start(
            workspace_id=workspace_id,
            document_id=document_id,
            kind="chunk_embed",
            force=False,
            executor="auto_ingest",
        )
    except KeyError:
        # Document vanished between event fire and start — caller
        # raced a delete. Silently drop.
        return
    except ValueError as exc:
        log.warning(
            "auto_ingest start failed for %s/%s: %s", workspace_id, document_id, exc
        )
        return
    if started["dedup_skipped"] or started["status"] in processing_runs.TERMINAL:
        return

    # Fire-and-forget — execute() emits its own progress events and
    # writes the terminal row. The event-bus task should return fast
    # so other subscribers run promptly.
    async def _bg() -> None:
        try:
            await processing_runs.execute(started["run_id"])
        except Exception:
            log.exception("auto_ingest execute failed: %s", started["run_id"])

    asyncio.create_task(_bg())


async def reconcile_missing_ingest(limit: int = 100) -> int:
    """Queue chunk_embed for chunkable docs that missed event delivery.

    The in-process event bus is intentionally non-durable. This sweep is
    the lightweight fallback: if a note/wiki document has no chunks and no
    active processing run, enqueue the same deduped auto-ingest path the
    event subscriber uses.
    """
    from app.common.db import pool

    async with pool().acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT d.workspace_id, d.id
            FROM documents d
            WHERE d.metadata->>'smartnote_type' = ANY($1::text[])
              AND NOT EXISTS (
                SELECT 1 FROM chunks c
                WHERE c.workspace_id = d.workspace_id AND c.document_id = d.id
              )
              AND NOT EXISTS (
                SELECT 1 FROM processing_runs pr
                WHERE pr.workspace_id = d.workspace_id
                  AND pr.document_id = d.id
                  AND pr.kind = 'chunk_embed'
                  AND pr.status IN ('queued', 'running')
              )
            ORDER BY d.updated_at ASC
            LIMIT $2
            """,
            list(_AUTO_INGEST_KINDS),
            limit,
        )
    for row in rows:
        await _start_auto_ingest(str(row["workspace_id"]), str(row["id"]))
    return len(rows)


async def _on_document_created(e: DocumentCreated) -> None:
    await _auto_ingest(e.workspace_id, e.document_id, e.smartnote_type)


async def _on_document_content_changed(e: DocumentContentChanged) -> None:
    # Chunk pipeline is idempotent (DELETE-then-INSERT chunks for the
    # doc), so re-running on content change is the right move.
    await _auto_ingest(e.workspace_id, e.document_id, e.smartnote_type)


async def _on_document_deleted(e: DocumentDeleted) -> None:
    await service.on_document_deleted(e.workspace_id, e.document_id)


def register() -> None:
    """Called once from main.py at startup."""
    events.subscribe(DocumentCreated, _on_document_created)
    events.subscribe(DocumentContentChanged, _on_document_content_changed)
    events.subscribe(DocumentDeleted, _on_document_deleted)
