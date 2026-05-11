"""Canonical Cloud -> client realtime event protocol.

New websocket payloads use this additive envelope:
event/type, schema_version, at, workspace_id, document_id, run_id,
stage, status, progress, message/error, data.

Every event with a workspace_id is persisted to `pipeline_events`
(migration 027) so the log query panel can replay run history. The
broadcast call is fire-and-forget; persistence failure must not
break the live WS path.

Legacy `type` names remain so older Desktop builds continue to work.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
import json
from typing import Any, Literal
from uuid import UUID

from app.common import ws_registry
from app.common.db import pool

log = logging.getLogger(__name__)

# Library processing stages. Keep this aligned with
# docs/library-client-integration.md.
Stage = Literal[
    "chunk_embed",
    "chunk_enrich",
    "graph_topology",
    "wiki_abstract",
    "note_classify",
]
Status = Literal["queued", "running", "done", "failed", "partial", "skipped"]


def event_payload(
    *,
    event: str,
    workspace_id: str | None = None,
    document_id: str | None = None,
    run_id: str | None = None,
    stage: Stage | str | None = None,
    status: Status | str | None = None,
    progress_current: int | None = None,
    progress_total: int | None = None,
    message: str | None = None,
    error: str | dict[str, Any] | None = None,
    data: dict[str, Any] | None = None,
    **legacy: Any,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "type": event,
        "event": event,
        "schema_version": 1,
        "at": datetime.now(timezone.utc).isoformat(),
    }
    if workspace_id is not None:
        payload["workspace_id"] = workspace_id
    if document_id is not None:
        payload["document_id"] = document_id
    if run_id is not None:
        payload["run_id"] = run_id
    if stage is not None:
        payload["stage"] = stage
        payload.setdefault("kind", stage)
    if status is not None:
        payload["status"] = status
    if progress_current is not None or progress_total is not None:
        payload["progress"] = {
            "current": int(progress_current or 0),
            "total": int(progress_total or 0),
        }
    if message is not None:
        payload["message"] = message
    if error is not None:
        payload["error"] = error
    if data is not None:
        payload["data"] = data
    payload.update({k: v for k, v in legacy.items() if v is not None})
    return payload


def broadcast(workspace_id: str, payload: dict[str, Any]) -> None:
    """Fire-and-forget — fans out to live WS clients AND persists to
    pipeline_events. Both legs are independent: a DB hiccup must not
    drop a live event, and a WS registry miss must not lose the audit
    trail.
    """
    try:
        asyncio.create_task(ws_registry.broadcast(workspace_id, payload))
    except Exception:
        pass
    try:
        asyncio.create_task(_persist_event(workspace_id, payload))
    except Exception:
        # No event loop yet (early boot) — give up silently; this path
        # only fires once for telemetry events at startup.
        pass


async def _persist_event(workspace_id: str, payload: dict[str, Any]) -> None:
    """Insert one row into pipeline_events. Errors are swallowed
    (logged at debug) so persistence problems never propagate into
    the broadcast caller's request path."""
    if not workspace_id:
        return
    try:
        p = pool()
    except AssertionError:
        return  # pool not initialized (early boot / tests without DB)
    try:
        ws_uuid = UUID(workspace_id)
    except (TypeError, ValueError):
        return

    run_id = payload.get("run_id")
    try:
        run_uuid = UUID(run_id) if isinstance(run_id, str) else None
    except (TypeError, ValueError):
        run_uuid = None

    doc_id = payload.get("document_id")
    try:
        doc_uuid = UUID(doc_id) if isinstance(doc_id, str) else None
    except (TypeError, ValueError):
        doc_uuid = None

    # Strip envelope keys; everything else (progress, etc.) lands in
    # `data` for ad-hoc querying. The fixed columns above cover the hot
    # filters; data jsonb stays open for future fields without schema
    # churn.
    envelope_keys = {
        "type",
        "event",
        "schema_version",
        "at",
        "workspace_id",
        "document_id",
        "run_id",
        "stage",
        "kind",
        "status",
        "message",
        "error",
    }
    data: dict[str, Any] = {k: v for k, v in payload.items() if k not in envelope_keys}
    # `progress` is structured but useful in the data blob too — keep both
    if "progress" in payload and "progress" not in data:
        data["progress"] = payload["progress"]

    try:
        async with p.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO pipeline_events
                  (workspace_id, run_id, document_id, stage, event, status,
                   message, error, schema_version, data)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                """,
                ws_uuid,
                run_uuid,
                doc_uuid,
                payload.get("stage") or payload.get("kind"),
                payload.get("event") or payload.get("type") or "unknown",
                payload.get("status"),
                payload.get("message"),
                _text_error(payload.get("error")),
                int(payload.get("schema_version") or 1),
                data,
            )
    except Exception as e:
        log.debug("pipeline_events insert failed: %s", e, exc_info=True)


def _text_error(error: Any) -> str | None:
    if error is None:
        return None
    if isinstance(error, str):
        return error
    try:
        return json.dumps(error, ensure_ascii=False)
    except Exception:
        return str(error)
