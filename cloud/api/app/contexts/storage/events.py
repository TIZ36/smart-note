"""Events the storage context publishes.

Subscribers live in other contexts (knowledge, enrichment, telemetry).
Adding a new event here is the only way for storage to fan out work
without importing the consumer — see ARCHITECTURE.md §4.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class DocumentCreated:
    """Fired right after a document row lands. The chunk + embed
    pipeline (knowledge) and the enrich queue (enrichment) both hang
    off this event."""
    workspace_id: str
    document_id: str
    smartnote_type: str | None
    # Set when the desktop / agent explicitly wants enrich to run on
    # this doc regardless of the workspace's `auto_enrich_on_ingest`
    # toggle. A passive sync push leaves this False and respects the
    # workspace setting.
    force_enrich: bool = False


@dataclass(frozen=True)
class DocumentContentChanged:
    """Fired when a PATCH actually changed the doc body (not metadata
    rename / type tweak). Triggers re-ingest in knowledge."""
    workspace_id: str
    document_id: str
    smartnote_type: str | None
    force_enrich: bool = False


@dataclass(frozen=True)
class DocumentDeleted:
    """Fired after a document is removed. Knowledge cleanup is mostly
    automatic via FK CASCADE on chunks / tag_segments / enrich_jobs;
    this event exists for downstream side effects (cache invalidation,
    activity feed entries) that aren't FK-driven."""
    workspace_id: str
    document_id: str
