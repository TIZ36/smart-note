"""Identity context — persistence.

Owns reads/writes to: tenants, workspaces, api_keys, devices,
pairing_codes. Today this module exposes only the read API the
console aggregator needs; auth + device CRUD still lives inline in
`app/routers/auth.py` and `app/routers/devices.py`.
"""

from __future__ import annotations

from datetime import datetime, timezone
from uuid import UUID

from app.db import pool
# DEVICE_ONLINE_WINDOW_SEC stays in routers/devices.py as the canonical
# heartbeat window; we reuse the constant rather than redefining it so
# the device list and console "primary online" badge can't diverge.
from app.routers.devices import DEVICE_ONLINE_WINDOW_SEC


async def count_devices(workspace_id: str) -> int:
    async with pool().acquire() as conn:
        n = await conn.fetchval(
            "SELECT count(*) FROM devices WHERE workspace_id = $1",
            UUID(workspace_id),
        )
    return int(n or 0)


async def primary_device_online(workspace_id: str) -> bool:
    async with pool().acquire() as conn:
        last_seen = await conn.fetchval(
            "SELECT last_seen_at FROM devices "
            "WHERE workspace_id = $1 AND is_primary = true",
            UUID(workspace_id),
        )
    if not last_seen:
        return False
    age = (datetime.now(timezone.utc) - last_seen).total_seconds()
    return age < DEVICE_ONLINE_WINDOW_SEC
