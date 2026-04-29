"""Enrichment context — event subscriptions.

Listens for documents landing/changing and asks the service whether
to queue an enrich job. Wiring is the *only* place enrichment talks
to the event bus; policy + dispatch live in service.py.
"""

from __future__ import annotations

from app.contexts.enrichment import service
from app.contexts.storage.events import DocumentContentChanged, DocumentCreated
from app.infra import events


async def _on_document_created(e: DocumentCreated) -> None:
    await service.queue_enrich_if_eligible(
        e.workspace_id, e.document_id,
        smartnote_type=e.smartnote_type,
        force=e.force_enrich,
    )


async def _on_document_content_changed(e: DocumentContentChanged) -> None:
    await service.queue_enrich_if_eligible(
        e.workspace_id, e.document_id,
        smartnote_type=e.smartnote_type,
        force=e.force_enrich,
    )


def register() -> None:
    """Called once from main.py at startup."""
    events.subscribe(DocumentCreated, _on_document_created)
    events.subscribe(DocumentContentChanged, _on_document_content_changed)
