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
