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


async def _ensure_device_for_key(workspace_id: str, api_key_id: str) -> str | None:
    """Resolve / lazily create a device row bound to this api_key.

    Bootstrap-issued keys (`POST /v1/dev/bootstrap`) and any other
    key that wasn't minted via the /pair+/claim flow have
    `api_keys.device_id IS NULL` and no devices row, so the workspace
    UI shows "No devices online" forever even when the desktop is
    actively connected. The WS connect is the strongest "this api_key
    has a real device behind it" signal we get, so use it to repair
    the binding once and keep heartbeats / online indicator working
    for every key going forward.

    Returns the device_id (existing or newly created), or None on any
    DB error (we don't want online plumbing to break the WS handler)."""
    try:
        ak_uuid = UUID(api_key_id)
        ws_uuid = UUID(workspace_id)
    except (TypeError, ValueError):
        return None
    try:
        async with pool().acquire() as conn:
            existing = await conn.fetchval(
                "SELECT device_id FROM api_keys WHERE id = $1",
                ak_uuid,
            )
            if existing:
                return str(existing)
            # First device in a workspace becomes primary so existing
            # `is_primary` consumers (BottomBar dot, ws_relay routing
            # for enrich jobs) treat it as the canonical device. Later
            # devices land as is_primary=false to avoid violating
            # `idx_devices_one_primary`.
            has_primary = await conn.fetchval(
                "SELECT EXISTS(SELECT 1 FROM devices WHERE workspace_id=$1 AND is_primary=true)",
                ws_uuid,
            )
            row = await conn.fetchrow(
                """
                INSERT INTO devices (workspace_id, name, platform, is_primary, last_seen_at)
                VALUES ($1, $2, 'desktop', $3, now())
                RETURNING id
                """,
                ws_uuid,
                "desktop",
                not has_primary,
            )
            await conn.execute(
                "UPDATE api_keys SET device_id = $1 WHERE id = $2",
                row["id"],
                ak_uuid,
            )
            return str(row["id"])
    except Exception as e:
        log.warning("ws_relay: ensure_device_for_key failed ws=%s key=%s err=%s",
                    workspace_id, api_key_id, e)
        return None


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
    # If the desktop didn't know its device_id (bootstrap-issued key
    # has none yet), lazily create + bind one. This makes the online
    # indicator and /v1/devices listings work for every key without
    # forcing users through the /pair flow.
    if not device_id or device_id == "unknown":
        resolved = await _ensure_device_for_key(claims.workspace_id, claims.api_key_id)
        if resolved:
            device_id = resolved
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
