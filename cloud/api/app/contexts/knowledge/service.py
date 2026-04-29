"""Knowledge context — application layer.

Public entry point for ingest-side and cleanup-side work that other
contexts trigger (chunk+embed on document create, document_ref
cleanup on document delete). HTTP-side reads (search, retrieve, graph,
wiki) still live in `app.services.kb.*` and migrate later.
"""

from __future__ import annotations

import logging

from app.contexts.knowledge.repository import (
    KnowledgeCounts, cleanup_document_refs, count_for as _count_for,
)

log = logging.getLogger(__name__)

# Same allowlist as enrichment.service — non-chunkable kinds (smart_table,
# raw text without semantic) skip the index.
_INGEST_KINDS = {"note", "wiki_topic"}


async def ingest_document_for_kind(
    workspace_id: str, document_id: str, smartnote_type: str | None,
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
            workspace_id, document_id, smartnote_type, exc_info=True,
        )
        return False


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
                deleted, workspace_id, document_id,
            )
    except Exception:
        log.warning(
            "document_ref cleanup failed for %s/%s",
            workspace_id, document_id, exc_info=True,
        )
