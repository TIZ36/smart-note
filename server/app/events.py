"""In-process pub/sub for ingest progress events.

Both ingest.py and special_ingest.py emit progress lines to stderr (consumed by
the Electron-spawned CLI subprocess). When ingest runs inside the long-lived
FastAPI gateway instead (e.g. triggered via MCP or direct POST /ingest), those
stderr lines never reach the desktop UI. This module fans out the same events
to any SSE subscribers attached to the running gateway process.
"""

from __future__ import annotations

import queue
import threading
from typing import Any


_lock = threading.Lock()
_subscribers: list[queue.Queue] = []


def publish(event: dict[str, Any]) -> None:
    """Fan out an event to every live subscriber queue. Never raises."""
    with _lock:
        subs = list(_subscribers)
    for q in subs:
        try:
            q.put_nowait(event)
        except Exception:
            pass


def subscribe() -> queue.Queue:
    q: queue.Queue = queue.Queue(maxsize=1000)
    with _lock:
        _subscribers.append(q)
    return q


def unsubscribe(q: queue.Queue) -> None:
    with _lock:
        try:
            _subscribers.remove(q)
        except ValueError:
            pass
