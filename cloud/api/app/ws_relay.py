"""Primary device WebSocket endpoint — `/v1/device/relay`.

The desktop's main process opens a long-lived connection here. The
cloud pushes enrich jobs over the wire; the device runs classification
locally (BYOK never leaves the box) and sends segments back.
"""

from __future__ import annotations

import json
import logging

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect

from app.common import ws_registry
from app.security import verify_jwt
from app.services.enrich.executors import ws_relay

router = APIRouter(tags=["ws"])
log = logging.getLogger(__name__)


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
                await ws.send_text(json.dumps({"type": "pong"}))
            else:
                log.debug("unhandled ws msg type=%s", mtype)
    except WebSocketDisconnect:
        pass
    finally:
        ws_registry.unregister(claims.workspace_id, sess)
        log.info("device disconnected ws=%s device=%s", claims.workspace_id, device_id)
