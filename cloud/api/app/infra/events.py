"""In-process event bus.

Lets contexts publish/subscribe without importing each other. Today
it's a coroutine fan-out via asyncio.create_task; tomorrow the same
public API can be backed by a Redis stream / Postgres LISTEN-NOTIFY
adapter when we split smart-cloud out — handler signatures don't
change.

Design:
* Events are frozen dataclasses, dispatched by *type* (not name)
  so renaming gets a static type error rather than a silent miss.
* Subscriptions are registered at startup via each context's
  `wiring.py:register()`. main.py calls every wiring module after
  the app is built — registration order is irrelevant because
  `publish()` only fires after the loop is up.
* Handlers are fire-and-forget (`asyncio.create_task`) so a slow
  classifier doesn't block the request that wrote the document.
  Each handler is wrapped in try/except — one failing subscriber
  cannot starve others.
* No persistence. If the process crashes between publish and handler
  completion, the event is lost. For now the durable fallback is
  the database itself: storage already wrote the row, so the periodic
  reconciliation job (TODO) can replay missed work by scanning for
  documents without chunks. When this becomes load-bearing the in-
  process bus is replaced with the Redis adapter.
"""

from __future__ import annotations

import asyncio
import logging
from collections import defaultdict
from typing import Any, Awaitable, Callable, TypeVar

log = logging.getLogger(__name__)

# Event handler signature — accepts the event object, returns nothing.
T = TypeVar("T")
Handler = Callable[[T], Awaitable[None]]

_subscribers: dict[type, list[Handler[Any]]] = defaultdict(list)


def subscribe(event_type: type[T], handler: Handler[T]) -> None:
    """Register `handler` for events of type `event_type`. Idempotent
    on (event_type, handler) — calling twice with the same pair is a
    no-op so wiring modules can be re-imported safely."""
    if handler in _subscribers[event_type]:
        return
    _subscribers[event_type].append(handler)


async def publish(event: Any) -> None:
    """Fan out an event to every subscriber. Handlers run as
    independent tasks; a failing one does not affect siblings or
    the publisher.

    Returns immediately once tasks are scheduled. If the publisher
    needs to wait for handlers (e.g. tests), use `publish_sync`.
    """
    handlers = list(_subscribers.get(type(event), ()))
    for h in handlers:
        asyncio.create_task(_safe_invoke(h, event))


async def publish_sync(event: Any) -> None:
    """Like `publish` but await every handler. For tests and for the
    rare write path that genuinely depends on the side effect
    completing before returning to the caller. Avoid in request
    handlers — slow handlers will stall the response."""
    handlers = list(_subscribers.get(type(event), ()))
    await asyncio.gather(*(_safe_invoke(h, event) for h in handlers))


async def _safe_invoke(handler: Handler[Any], event: Any) -> None:
    try:
        await handler(event)
    except Exception:
        log.exception(
            "event handler %s.%s failed for %s",
            getattr(handler, "__module__", "?"),
            getattr(handler, "__qualname__", repr(handler)),
            type(event).__name__,
        )


def _reset_for_tests() -> None:
    """Clear all subscriptions. Test-only — don't call from prod code."""
    _subscribers.clear()
