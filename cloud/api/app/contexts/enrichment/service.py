"""Enrichment context — application layer.

The public entry point other contexts and routers call. Owns the
policy and execution path for LLM enrichment so HTTP routes, storage
events, and processing runs do not create competing ledger rows.
"""

from __future__ import annotations

import logging
import asyncio
import json
from datetime import datetime, timezone
from typing import Any, Literal
from uuid import UUID

from dataclasses import dataclass

from app.common import ws_registry
from app.common.db import pool
from app.contexts.enrichment.repository import (
    EnrichJobCounts,
    RecentJob,
    WorkspaceProviderConfig,
    count_for as _count_for,
    get_provider_config,
    recent_activity as _recent_activity,
)
from app.services import processing_runs as runs_ledger
from app.services.enrich import dispatcher
from app.services.enrich.classifier import DEFAULT_TAGS, ProviderConfig, run_classify
from app.services.enrich.protocols import EnrichJob, ExecutorKind

log = logging.getLogger(__name__)

# Line-range ai_enrich writes tag_segments. Wiki topics use the separate
# wiki_abstract pipeline because their natural unit is wiki_chapters.
_AI_ENRICHABLE_KINDS = {"note"}


class EnrichmentError(Exception):
    pass


class EnrichDocumentNotFound(EnrichmentError):
    pass


class EnrichUnsupportedKind(EnrichmentError):
    pass


async def count_for(workspace_id: str) -> EnrichJobCounts:
    """Public read accessor for console / telemetry."""
    return await _count_for(workspace_id)


async def recent_activity(workspace_id: str, limit: int = 5) -> list[RecentJob]:
    """Newest-first job list for the console activity feed."""
    return await _recent_activity(workspace_id, limit)


@dataclass(frozen=True)
class ExecutorAvailability:
    """Whether each executor strategy is currently usable. Computed
    on demand — no caching; the answers change as devices connect /
    disconnect and as workspace configs are saved."""

    mcp_pull: bool
    ws_relay: bool
    cloud_pool: bool


async def executors_status(workspace_id: str) -> ExecutorAvailability:
    """Runtime status of the three enrich strategies. mcp_pull /
    cloud_pool ask their executor modules; ws_relay reads the live
    WebSocket registry (a primary device with an open WS can serve
    enrich requests in real time)."""
    # Imported lazily so this service module stays cheap and the
    # executor modules' import-time deps (httpx, asyncio plumbing)
    # don't run unless someone asks for status.
    from app.common import ws_registry
    from app.services.enrich.executors import cloud_pool, mcp_pull

    return ExecutorAvailability(
        mcp_pull=await mcp_pull.is_available(workspace_id),
        ws_relay=ws_registry.has_primary(workspace_id),
        cloud_pool=await cloud_pool.is_available(workspace_id),
    )


async def get_workspace_provider(workspace_id: str) -> WorkspaceProviderConfig | None:
    """Read-only accessor used by the desktop's Cloud Console (via the
    HTTP /v1/enrich/provider route) and by the auto-enrich subscriber.
    Returns None when the workspace hasn't saved an LLM key yet."""
    return await get_provider_config(workspace_id)


async def queue_enrich_if_eligible(
    workspace_id: str,
    document_id: str,
    *,
    smartnote_type: str | None,
    force: bool,
    revision: int = 0,
    api_key_id: str | None = None,
    executor_prefs: list[ExecutorKind] | None = None,
) -> str | None:
    """Policy + dispatch in one call. Returns the processing_runs id iff
    a job was actually queued or run.

    Eligibility rules (all must hold):
      1. doc kind is enrichable (note; wiki_topic uses wiki_abstract)
      2. workspace has a saved LLM provider
      3. either `force=True` (caller explicitly opted in — desktop
         "Ingest All" / `full_ingest(enrich_with_ai=True)`)
         OR the workspace's `auto_enrich_on_ingest` preference is on
    """
    if smartnote_type not in _AI_ENRICHABLE_KINDS:
        return None
    cfg = await get_provider_config(workspace_id)
    if cfg is None:
        return None
    if not force and not cfg.auto_enrich_on_ingest:
        return None

    try:
        return await run_enrich(
            workspace_id=workspace_id,
            document_id=document_id,
            api_key_id=api_key_id or "auto-ingest",
            revision=revision,
            executor="dispatcher",
            executor_prefs=executor_prefs or ["cloud_pool"],
        )
    except Exception:
        log.warning(
            "auto-enrich failed for %s/%s",
            workspace_id,
            document_id,
            exc_info=True,
        )
        return None


async def run_enrich(
    *,
    workspace_id: str,
    document_id: str,
    api_key_id: str | None,
    revision: int = 0,
    tags: list[str] | None = None,
    provider: ProviderConfig | None = None,
    executor_prefs: list[ExecutorKind] | None = None,
    executor: str | None = None,
) -> str:
    """Create or reuse one ai_enrich processing_run and dispatch it.

    Returns the processing_runs id. When no executor is available, the row
    is left queued for /v1/enrich/pending.
    """
    ws_uuid = UUID(workspace_id)
    doc_uuid = UUID(document_id)

    async with pool().acquire() as conn:
        doc = await conn.fetchrow(
            "SELECT id, content, metadata FROM documents WHERE id=$1 AND workspace_id=$2",
            doc_uuid,
            ws_uuid,
        )
    if not doc:
        raise EnrichDocumentNotFound("document not found")

    meta = doc["metadata"] or {}
    if isinstance(meta, str):
        try:
            meta = json.loads(meta)
        except Exception:
            meta = {}
    if (meta.get("smartnote_type") or "") == "wiki_topic":
        raise EnrichUnsupportedKind(
            "wiki_topic documents enrich via /v1/processing/{id}/run "
            "kind=wiki_abstract — chapter summarization replaces tag_segments"
        )

    run_id = await runs_ledger.start(
        workspace_id=workspace_id,
        document_id=str(doc_uuid),
        kind="ai_enrich",
        revision=revision,
        executor=executor or ("cloud_pool" if provider is not None else "dispatcher"),
        api_key_id=api_key_id,
        status="queued",
    )
    if run_id is None:
        raise EnrichmentError("processing_runs ledger unavailable")

    if provider is not None:
        await runs_ledger.promote_queued_to_running(run_id=run_id)
        try:
            lines = (doc["content"] or "").splitlines()
            out = await asyncio.to_thread(
                run_classify,
                lines,
                provider,
                tags or DEFAULT_TAGS,
            )
        except Exception as e:
            log.exception("inline enrich failed")
            await runs_ledger.finish(run_id=run_id, status="failed", error=str(e))
            return run_id
        async with pool().acquire() as conn:
            await write_segments_done(
                conn,
                ws_uuid,
                doc_uuid,
                run_id,
                out.segments,
                "cloud_pool",
                out.prompt_tokens,
                out.completion_tokens,
                out.total_tokens,
            )
        return run_id

    ej = EnrichJob(
        job_id=run_id,
        workspace_id=workspace_id,
        document_id=str(doc_uuid),
        content=doc["content"] or "",
        tags=tags or list(DEFAULT_TAGS),
        executor_prefs=list(executor_prefs or []),
    )
    await runs_ledger.promote_queued_to_running(run_id=run_id)
    outcome = await dispatcher.dispatch(ej)
    if outcome.executor and outcome.segments:
        async with pool().acquire() as conn:
            await write_segments_done(
                conn,
                ws_uuid,
                doc_uuid,
                run_id,
                outcome.segments,
                outcome.executor,
                outcome.prompt_tokens,
                outcome.completion_tokens,
                outcome.total_tokens,
            )
    else:
        async with pool().acquire() as conn:
            await conn.execute(
                "UPDATE processing_runs SET status='queued', started_at=NULL "
                "WHERE id=$1 AND status='running'",
                UUID(run_id),
            )
    return run_id


async def write_segments_done(
    conn,
    ws_uuid,
    doc_uuid,
    run_id: str | None,
    segments: list[dict[str, Any]],
    executor: ExecutorKind | Literal["cloud_pool", "mcp_pull", "ws_relay"],
    prompt_tokens: int = 0,
    completion_tokens: int = 0,
    total_tokens: int = 0,
) -> None:
    """Land enriched segments and close the canonical processing_runs row."""
    from app.services.kb.entity_graph import upsert_entities_for_segments

    async with conn.transaction():
        await conn.execute("DELETE FROM tag_segments WHERE document_id=$1", doc_uuid)
        for seg in segments:
            await conn.execute(
                """
                INSERT INTO tag_segments
                    (workspace_id, document_id, start_line, end_line,
                     tag, confidence, summary, meta)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
                """,
                ws_uuid,
                doc_uuid,
                int(seg.get("line_start", 0)),
                int(seg.get("line_end", 0)),
                str(seg.get("tag") or "others"),
                float(seg.get("confidence", 0.0)),
                str(seg.get("summary") or ""),
                json.dumps(
                    {
                        "secondary_tags": seg.get("secondary_tags", []),
                        "topic_name": seg.get("topic_name", ""),
                        "keywords": seg.get("keywords", []),
                        "entities": seg.get("entities", []),
                        "is_credential": bool(seg.get("is_credential", False)),
                    }
                ),
            )
        try:
            await upsert_entities_for_segments(conn, str(ws_uuid), segments)
        except Exception as e:
            log.warning("entity graph upsert failed for doc %s: %s", doc_uuid, e)

    result_payload = {
        "segments_count": len(segments),
        "prompt_tokens": prompt_tokens,
        "completion_tokens": completion_tokens,
        "total_tokens": total_tokens,
        "executor": executor,
    }
    if run_id is not None:
        await runs_ledger.finish(run_id=run_id, status="done", result=result_payload)
    else:
        await runs_ledger.finish_latest(
            workspace_id=str(ws_uuid),
            document_id=str(doc_uuid),
            kind="ai_enrich",
            status="done",
            result=result_payload,
        )

    try:
        name_row = await conn.fetchrow(
            "SELECT name FROM documents WHERE id=$1", doc_uuid
        )
        payload = {
            "type": "enrich_done",
            "document_id": str(doc_uuid),
            "document_name": name_row["name"] if name_row else None,
            "segments_count": len(segments),
            "tokens_total": total_tokens,
            "executor": executor,
            "at": datetime.now(timezone.utc).isoformat(),
        }
        asyncio.create_task(ws_registry.broadcast(str(ws_uuid), payload))
    except Exception:
        pass
