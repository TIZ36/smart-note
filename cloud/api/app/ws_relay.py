"""Primary device WebSocket endpoint — `/v1/device/relay`.

The desktop's main process opens a long-lived connection here. The
cloud pushes enrich jobs + agent_active events + memory_proposed
notifications over the wire; the device runs classification locally
and sends segments back.

Connection presence ALSO doubles as the device's heartbeat — every
connect / ping bumps `devices.last_seen_at` so the workspace
registry's online indicator is accurate without a separate HTTP
heartbeat poll.
"""

from __future__ import annotations

import json
import logging
from uuid import UUID

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect

from app.common import ws_registry
from app.common.db import pool
from app.security import verify_jwt
from app.services.enrich.executors import ws_relay

router = APIRouter(tags=["ws"])
log = logging.getLogger(__name__)


async def _bump_last_seen(device_id: str) -> None:
    """Best-effort UPDATE devices.last_seen_at = now(). Skips on
    parse errors / unknown ids — never raises into the WS handler."""
    if not device_id or device_id == "unknown":
        return
    try:
        dev_uuid = UUID(device_id)
    except ValueError:
        return
    try:
        async with pool().acquire() as conn:
            await conn.execute(
                "UPDATE devices SET last_seen_at = now() WHERE id = $1",
                dev_uuid,
            )
    except Exception:
        pass


@router.websocket("/v1/device/relay")
async def device_relay(
    ws: WebSocket,
    token: str = Query(..., description="SmartNote JWT"),
    device_id: str = Query("unknown"),
) -> None:
    claims = verify_jwt(token)
    if not claims:
        await ws.close(code=4401)
        return
    await ws.accept()
    sess = ws_registry.register(claims.workspace_id, ws, device_id)
    # WS connect itself is the strongest heartbeat signal — bump
    # last_seen_at immediately so the device shows online right away.
    await _bump_last_seen(device_id)
    log.info("device connected ws=%s ws_id=%s device=%s", claims.workspace_id, sess.id, device_id)
    try:
        while True:
            text = await ws.receive_text()
            try:
                payload = json.loads(text)
            except Exception:
                await ws.send_text(json.dumps({"type": "error", "error": "invalid json"}))
                continue
            mtype = payload.get("type")
            if mtype in ("enrich_result", "enrich_error"):
                ws_relay.deliver(claims.workspace_id, payload)
            elif mtype == "ping":
                # Ping doubles as heartbeat — bump device row so the
                # online indicator stays fresh. No-op if device_id
                # didn't parse as a UUID.
                await _bump_last_seen(device_id)
                await ws.send_text(json.dumps({"type": "pong"}))
            elif mtype == "hello":
                # Initial handshake — desktop announces itself with
                # version / platform info. We just ack so it can
                # confirm the link is healthy.
                await ws.send_text(json.dumps({
                    "type": "hello-ack",
                    "workspace_id": claims.workspace_id,
                    "device_id": device_id,
                }))
            else:
                log.debug("unhandled ws msg type=%s", mtype)
    except WebSocketDisconnect:
        pass
    finally:
        ws_registry.unregister(claims.workspace_id, sess)
        log.info("device disconnected ws=%s device=%s", claims.workspace_id, device_id)
