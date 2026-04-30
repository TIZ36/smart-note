"""Knowledge context — event subscriptions.

Reacts to document lifecycle events from storage. Wiring is the only
place knowledge talks to the event bus; chunk+embed and cleanup
policy live in service.py.

Every auto-ingest call lands a processing_runs row + broadcasts
chunk_embed_done so the desktop's Library KN view and KP page see
state change in real-time, identically to an explicit
POST /v1/processing/.../run kind=chunk_embed call. Without this,
auto-ingest (the most common path) was invisible from every UI
surface.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone

from app.common import ws_registry
from app.contexts.knowledge import service
from app.contexts.storage.events import (
    DocumentContentChanged, DocumentCreated, DocumentDeleted,
)
from app.infra import events
from app.services import processing_runs as runs_ledger

log = logging.getLogger(__name__)


def _broadcast_embed_done(workspace_id: str, document_id: str, smartnote_type: str | None) -> None:
    """Same shape as processing.py's chunk_embed_done so the desktop
    has a single handler. Fire-and-forget."""
    payload = {
        "type": "chunk_embed_done",
        "document_id": document_id,
        "smartnote_type": smartnote_type or "doc",
        "at": datetime.now(timezone.utc).isoformat(),
    }
    try:
        asyncio.create_task(ws_registry.broadcast(workspace_id, payload))
    except Exception:
        log.exception("auto-ingest broadcast failed")


async def _record_and_run(workspace_id: str, document_id: str, smartnote_type: str | None) -> None:
    """Wrap service.ingest_document_for_kind with ledger + broadcast.
    Trigger info points at 'auto' so dashboards can split explicit
    KP-button runs from background ingestion."""
    run_id = await runs_ledger.start(
        workspace_id=workspace_id, document_id=document_id,
        kind="chunk_embed", revision=0, executor="auto_ingest",
        api_key_id=None,
    )
    try:
        ran = await service.ingest_document_for_kind(
            workspace_id, document_id, smartnote_type,
        )
    except Exception as e:
        await runs_ledger.finish(run_id=run_id, status="failed", error=str(e))
        raise
    await runs_ledger.finish(
        run_id=run_id,
        status="done" if ran else "skipped_dedup",
        result={"smartnote_type": smartnote_type or "doc", "ran": bool(ran)},
    )
    if ran:
        _broadcast_embed_done(workspace_id, document_id, smartnote_type)


async def _on_document_created(e: DocumentCreated) -> None:
    await _record_and_run(e.workspace_id, e.document_id, e.smartnote_type)


async def _on_document_content_changed(e: DocumentContentChanged) -> None:
    # Chunk pipeline is idempotent (DELETE-then-INSERT chunks for the
    # doc), so re-running on content change is the right move.
    await _record_and_run(e.workspace_id, e.document_id, e.smartnote_type)


async def _on_document_deleted(e: DocumentDeleted) -> None:
    await service.on_document_deleted(e.workspace_id, e.document_id)


def register() -> None:
    """Called once from main.py at startup."""
    events.subscribe(DocumentCreated, _on_document_created)
    events.subscribe(DocumentContentChanged, _on_document_content_changed)
    events.subscribe(DocumentDeleted, _on_document_deleted)
