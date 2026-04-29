"""Identity context — application layer.

Public read accessors. Auth + device CRUD still lives in legacy
routers; lifted here on the next pass.
"""

from __future__ import annotations

from app.contexts.identity import repository as repo


async def count_devices(workspace_id: str) -> int:
    return await repo.count_devices(workspace_id)


async def primary_device_online(workspace_id: str) -> bool:
    return await repo.primary_device_online(workspace_id)
