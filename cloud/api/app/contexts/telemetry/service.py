"""Telemetry context — application layer.

Console aggregator + usage snapshot. The aggregation pattern is the
canonical example of how cross-context reads SHOULD work post-DDD:
no SQL touches another context's tables, every count comes from the
owning context's `count_for(workspace_id)`. Replacing each call with
an RPC after the smart-cloud split is a one-line change per call.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass

from app.contexts.enrichment import service as enrichment
from app.contexts.identity import service as identity
from app.contexts.knowledge import service as knowledge
from app.contexts.storage import service as storage


@dataclass(frozen=True)
class ConsoleSnapshot:
    """Everything the desktop's Cloud Console homepage renders in one
    aggregated payload. Values come from each context's own count API,
    so the console doesn't need to know any schema."""
    # Storage
    documents_total: int
    notes: int
    wiki_topics: int
    # Knowledge
    memories: int
    proposals_pending: int
    chunks: int
    tag_segments: int
    distinct_tags: int
    wiki_nodes: int
    # Enrichment
    enrich_queued: int
    enrich_running: int
    enrich_done: int
    enrich_failed: int
    # Identity
    devices: int
    primary_device_online: bool


async def console_snapshot(workspace_id: str) -> ConsoleSnapshot:
    """One round-trip per context, run in parallel. The aggregator
    isn't allowed to know which tables back which numbers — the only
    SQL that runs lives inside each context's repository."""
    docs, kn, en, dev_count, primary_online = await asyncio.gather(
        storage.count_for(workspace_id),
        knowledge.count_for(workspace_id),
        enrichment.count_for(workspace_id),
        identity.count_devices(workspace_id),
        identity.primary_device_online(workspace_id),
    )
    return ConsoleSnapshot(
        documents_total=docs.total,
        notes=docs.notes,
        wiki_topics=docs.wiki_topics,
        memories=kn.memories,
        proposals_pending=kn.proposals_pending,
        chunks=kn.chunks,
        tag_segments=kn.tag_segments,
        distinct_tags=kn.distinct_tags,
        wiki_nodes=kn.wiki_nodes,
        enrich_queued=en.queued,
        enrich_running=en.running,
        enrich_done=en.done,
        enrich_failed=en.failed,
        devices=dev_count,
        primary_device_online=primary_online,
    )
