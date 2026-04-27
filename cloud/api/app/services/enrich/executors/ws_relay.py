"""ws_relay executor — relay the job to a primary device over WebSocket.

The primary device unwraps its BYOK key locally, runs classification,
and sends the segments back. The cloud never sees the API key.

Protocol over the WS (JSON frames):
  cloud → device: {"type":"enrich","request_id":"...","tags":[...],"content":"..."}
  device → cloud: {"type":"enrich_result","request_id":"...","segments":[...],
                   "prompt_tokens":N,"completion_tokens":N}
  device → cloud: {"type":"enrich_error","request_id":"...","error":"..."}
"""

from __future__ import annotations

import asyncio
import json
import logging
from uuid import uuid4

from app.common import ws_registry
from app.services.enrich.protocols import EnrichJob, EnrichOutcome

kind = "ws_relay"
log = logging.getLogger(__name__)

RELAY_TIMEOUT_SEC = 90.0


async def is_available(workspace_id: str) -> bool:
    return ws_registry.has_primary(workspace_id)


async def run(job: EnrichJob) -> EnrichOutcome:
    sess = ws_registry.pick(job.workspace_id)
    if sess is None:
        return EnrichOutcome(job.job_id, [], None, error="no primary device")

    request_id = str(uuid4())
    fut: asyncio.Future = asyncio.get_event_loop().create_future()
    sess.pending[request_id] = fut
    try:
        await sess.ws.send_text(json.dumps({
            "type": "enrich",
            "request_id": request_id,
            "job_id": job.job_id,
            "tags": job.tags,
            "content": job.content,
        }))
        try:
            payload = await asyncio.wait_for(fut, timeout=RELAY_TIMEOUT_SEC)
        except asyncio.TimeoutError:
            return EnrichOutcome(job.job_id, [], None, error="device timeout")
        if payload.get("type") == "enrich_error":
            return EnrichOutcome(job.job_id, [], None, error=str(payload.get("error", "device error")))
        return EnrichOutcome(
            job_id=job.job_id,
            segments=list(payload.get("segments") or []),
            executor="ws_relay",
            prompt_tokens=int(payload.get("prompt_tokens") or 0),
            completion_tokens=int(payload.get("completion_tokens") or 0),
            total_tokens=int(payload.get("total_tokens") or 0),
        )
    finally:
        sess.pending.pop(request_id, None)


def deliver(workspace_id: str, payload: dict) -> bool:
    """Called by the WS endpoint when a frame arrives from a device.
    Resolves the matching pending future. Returns True if dispatched."""
    rid = payload.get("request_id")
    if not rid:
        return False
    sess = ws_registry.pick(workspace_id)
    if sess is None:
        return False
    fut = sess.pending.get(rid)
    if fut and not fut.done():
        fut.set_result(payload)
        return True
    return False
