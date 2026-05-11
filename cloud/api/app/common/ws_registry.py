"""In-process WebSocket session map (workspace_id → set[WebSocket]).

MVP scope: single api pod. When we go multi-pod we swap this for Redis
pub/sub on the same key — every method here stays the same.
"""

from __future__ import annotations

import asyncio
from collections import defaultdict
from typing import Any
from uuid import uuid4


class _Session:
    __slots__ = ("id", "ws", "device_id", "pending")

    def __init__(self, ws: Any, device_id: str):
        self.id = str(uuid4())
        self.ws = ws
        self.device_id = device_id
        # request_id → asyncio.Future (waiting for the relayed reply).
        self.pending: dict[str, asyncio.Future] = {}


_sessions: dict[str, set[_Session]] = defaultdict(set)


def register(workspace_id: str, ws: Any, device_id: str) -> _Session:
    s = _Session(ws, device_id)
    _sessions[workspace_id].add(s)
    return s


def unregister(workspace_id: str, session: _Session) -> None:
    _sessions.get(workspace_id, set()).discard(session)
    for fut in session.pending.values():
        if not fut.done():
            fut.set_exception(ConnectionError("device disconnected"))


def has_primary(workspace_id: str) -> bool:
    return bool(_sessions.get(workspace_id))


def pick(workspace_id: str) -> _Session | None:
    """First available session for a workspace. MVP just grabs any one;
    when we add multi-device routing this picks by primary flag."""
    for s in _sessions.get(workspace_id, set()):
        return s
    return None


async def broadcast(workspace_id: str, payload: dict) -> int:
    """Fan-out a JSON payload to every open desktop session in this
    workspace. Used to push real-time events (agent activity, enrich
    completion, memory proposed) so desktops update without polling.

    Returns the number of sessions that successfully received it.
    Sessions that fail are silently ignored — disconnect handlers
    will GC them. Best-effort by design.
    """
    import json
    import logging
    log = logging.getLogger(__name__)
    sessions = list(_sessions.get(workspace_id, set()))
    etype = payload.get("event") or payload.get("type")
    if not sessions:
        log.warning("ws.broadcast NO_SESSIONS ws=%s event=%s run=%s",
                    workspace_id, etype, payload.get("run_id"))
        return 0
    text = json.dumps(payload, ensure_ascii=False)
    delivered = 0
    failed = 0
    for s in sessions:
        try:
            await s.ws.send_text(text)
            delivered += 1
        except Exception as e:
            failed += 1
            log.warning("ws.broadcast SEND_FAIL ws=%s session=%s device=%s err=%s",
                        workspace_id, s.id, s.device_id, e)
    log.info("ws.broadcast event=%s ws=%s sessions=%d delivered=%d failed=%d run=%s status=%s",
             etype, workspace_id, len(sessions), delivered, failed,
             payload.get("run_id"), payload.get("status"))
    return delivered


def session_count(workspace_id: str) -> int:
    """Open WS sessions for this workspace. Replaces HTTP heartbeat
    for "is anything online" — connection presence == online."""
    return len(_sessions.get(workspace_id, set()))
