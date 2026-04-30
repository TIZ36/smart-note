"""Knowledge context — application layer.

Public entry point for ingest-side and cleanup-side work that other
contexts trigger (chunk+embed on document create, document_ref
cleanup on document delete). HTTP-side reads (search, retrieve, graph,
wiki) still live in `app.services.kb.*` and migrate later.
"""

from __future__ import annotations

import logging
import asyncio
from datetime import datetime, timezone

from app.common import ws_registry
from app.contexts.knowledge.repository import (
    KnowledgeCounts,
    cleanup_document_refs,
    count_for as _count_for,
)
from app.services import processing_runs as runs_ledger

log = logging.getLogger(__name__)

# Same allowlist as enrichment.service — non-chunkable kinds (smart_table,
# raw text without semantic) skip the index.
_INGEST_KINDS = {"note", "wiki_topic"}


async def ingest_document_for_kind(
    workspace_id: str,
    document_id: str,
    smartnote_type: str | None,
) -> bool:
    """Run chunk + embed for an enrichable document. Returns True iff
    we actually invoked a pipeline (i.e. the kind is on the
    allowlist).

    Per-type dispatcher (docs/processing-pipeline.md §4):
      - 'note'       → app.services.ingest.pipeline.ingest_document
      - 'wiki_topic' → app.contexts.knowledge.wiki_processor.process_wiki_document
                       (extra step: extracts H2 chapters into wiki_chapters
                        before chunking each chapter independently)

    Failures are logged and swallowed — the doc is already saved, so
    a transient embed-pod blip shouldn't fail the original write.
    Reconciliation is the user manually clicking Rebuild, or a future
    nightly sweep that finds docs without chunks.
    """
    if smartnote_type not in _INGEST_KINDS:
        return False
    try:
        # Lazy imports: each branch pulls its own dependencies only
        # when that branch fires; keeps test imports cheap and avoids
        # a circular import between wiki_processor and ingest pipeline.
        if smartnote_type == "wiki_topic":
            from app.contexts.knowledge.wiki_processor import process_wiki_document

            await process_wiki_document(workspace_id, document_id)
        else:
            from app.services.ingest.pipeline import ingest_document

            await ingest_document(workspace_id, document_id)
        return True
    except Exception:
        log.warning(
            "ingest failed for %s/%s (kind=%s)",
            workspace_id,
            document_id,
            smartnote_type,
            exc_info=True,
        )
        return False


def _broadcast_embed_done(
    workspace_id: str, document_id: str, smartnote_type: str | None
) -> None:
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


async def record_and_ingest_document_for_kind(
    workspace_id: str,
    document_id: str,
    smartnote_type: str | None,
) -> None:
    """Run kind-aware ingest with the canonical processing_runs ledger.

    Trigger info points at 'auto' unless the caller passed an API key to
    the lower-level processing endpoint. This is the single shared path
    for storage events, explicit /v1/ingest/document, and bulk ingest.
    """
    run_id = await runs_ledger.start(
        workspace_id=workspace_id,
        document_id=document_id,
        kind="chunk_embed",
        revision=0,
        executor="auto_ingest",
        api_key_id=None,
    )
    try:
        ran = await ingest_document_for_kind(workspace_id, document_id, smartnote_type)
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


async def count_for(workspace_id: str) -> KnowledgeCounts:
    """Public read accessor for telemetry / console aggregation. The
    return type is owned by knowledge — telemetry passes it through
    unchanged so the schema is in one place."""
    return await _count_for(workspace_id)


async def on_document_deleted(workspace_id: str, document_id: str) -> None:
    """Clean up knowledge-owned rows that don't FK-cascade. Called
    from wiring.py via the DocumentDeleted subscription, never directly
    by storage."""
    try:
        deleted = await cleanup_document_refs(workspace_id, document_id)
        if deleted:
            log.info(
                "cleaned %d document_ref memories for %s/%s",
                deleted,
                workspace_id,
                document_id,
            )
    except Exception:
        log.warning(
            "document_ref cleanup failed for %s/%s",
            workspace_id,
            document_id,
            exc_info=True,
        )
