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

from app.contexts.knowledge import service
from app.contexts.storage.events import (
    DocumentContentChanged,
    DocumentCreated,
    DocumentDeleted,
)
from app.infra import events


async def _on_document_created(e: DocumentCreated) -> None:
    await service.record_and_ingest_document_for_kind(
        e.workspace_id,
        e.document_id,
        e.smartnote_type,
    )


async def _on_document_content_changed(e: DocumentContentChanged) -> None:
    # Chunk pipeline is idempotent (DELETE-then-INSERT chunks for the
    # doc), so re-running on content change is the right move.
    await service.record_and_ingest_document_for_kind(
        e.workspace_id,
        e.document_id,
        e.smartnote_type,
    )


async def _on_document_deleted(e: DocumentDeleted) -> None:
    await service.on_document_deleted(e.workspace_id, e.document_id)


def register() -> None:
    """Called once from main.py at startup."""
    events.subscribe(DocumentCreated, _on_document_created)
    events.subscribe(DocumentContentChanged, _on_document_content_changed)
    events.subscribe(DocumentDeleted, _on_document_deleted)
