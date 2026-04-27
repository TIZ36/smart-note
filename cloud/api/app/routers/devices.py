"""Device pairing + registry — `/v1/devices`.

MVP shape:
  * POST /v1/devices/pair      — issue a 6-digit code (Apple-TV style)
  * POST /v1/devices/claim     — desktop sends the code → we mint name
  * GET  /v1/devices            — list this workspace's devices
  * POST /v1/devices/{id}/promote — make this device the primary
  * DELETE /v1/devices/{id}     — unpair

Realtime status (online/offline) comes from `ws_registry`; we don't
persist it.
"""

from __future__ import annotations

import secrets
from datetime import datetime, timedelta, timezone
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel

from app.common import ws_registry
from app.common.db import pool
from app.deps import Identity, require_scope

router = APIRouter(prefix="/v1/devices", tags=["devices"])

PAIRING_TTL_MIN = 10


class DeviceOut(BaseModel):
    id: str
    name: str
    platform: str
    is_primary: bool
    online: bool
    last_seen_at: str | None
    created_at: str


class PairResponse(BaseModel):
    pairing_code: str
    expires_at: str
    device_id: str


class ClaimRequest(BaseModel):
    pairing_code: str
    name: str
    platform: str = "unknown"


def _row_to_out(r, online: bool) -> DeviceOut:
    return DeviceOut(
        id=str(r["id"]), name=r["name"], platform=r["platform"],
        is_primary=bool(r["is_primary"]), online=online,
        last_seen_at=r["last_seen_at"].isoformat() if r["last_seen_at"] else None,
        created_at=r["created_at"].isoformat(),
    )


@router.post("/pair", response_model=PairResponse,
             dependencies=[Depends(require_scope("admin"))])
async def issue_pairing(
    identity: Identity = Depends(require_scope("admin")),
) -> PairResponse:
    """Mint a one-shot 6-digit code. The desktop on the new device sends
    it back via /claim within 10 minutes."""
    ws = UUID(identity.workspace_id)
    code = f"{secrets.randbelow(1_000_000):06d}"
    expires = datetime.now(timezone.utc) + timedelta(minutes=PAIRING_TTL_MIN)
    async with pool().acquire() as conn:
        row = await conn.fetchrow(
            """
            INSERT INTO devices (workspace_id, name, platform, pairing_code, pairing_expires)
            VALUES ($1, '(unclaimed)', 'unknown', $2, $3)
            RETURNING id
            """,
            ws, code, expires,
        )
    return PairResponse(pairing_code=code, expires_at=expires.isoformat(),
                        device_id=str(row["id"]))


@router.post("/claim", response_model=DeviceOut,
             dependencies=[Depends(require_scope("admin"))])
async def claim_device(
    req: ClaimRequest,
    identity: Identity = Depends(require_scope("admin")),
) -> DeviceOut:
    ws = UUID(identity.workspace_id)
    async with pool().acquire() as conn:
        row = await conn.fetchrow(
            """
            UPDATE devices
            SET name = $3, platform = $4,
                pairing_code = NULL, pairing_expires = NULL,
                last_seen_at = now()
            WHERE workspace_id = $1
              AND pairing_code = $2
              AND pairing_expires > now()
            RETURNING *
            """,
            ws, req.pairing_code, req.name, req.platform,
        )
    if not row:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "invalid or expired code")
    return _row_to_out(row, online=False)


@router.get("", response_model=list[DeviceOut],
            dependencies=[Depends(require_scope("admin"))])
async def list_devices(
    identity: Identity = Depends(require_scope("admin")),
) -> list[DeviceOut]:
    ws = UUID(identity.workspace_id)
    async with pool().acquire() as conn:
        rows = await conn.fetch(
            "SELECT * FROM devices WHERE workspace_id = $1 ORDER BY is_primary DESC, last_seen_at DESC NULLS LAST",
            ws,
        )
    online = ws_registry.has_primary(identity.workspace_id)
    return [_row_to_out(r, online and bool(r["is_primary"])) for r in rows]


@router.post("/{device_id}/promote", response_model=DeviceOut,
             dependencies=[Depends(require_scope("admin"))])
async def promote(
    device_id: str,
    identity: Identity = Depends(require_scope("admin")),
) -> DeviceOut:
    ws = UUID(identity.workspace_id)
    dev = UUID(device_id)
    async with pool().acquire() as conn:
        async with conn.transaction():
            await conn.execute(
                "UPDATE devices SET is_primary = false WHERE workspace_id = $1",
                ws,
            )
            row = await conn.fetchrow(
                "UPDATE devices SET is_primary = true WHERE id = $1 AND workspace_id = $2 RETURNING *",
                dev, ws,
            )
    if not row:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "device not found")
    return _row_to_out(row, online=ws_registry.has_primary(identity.workspace_id))


@router.delete("/{device_id}",
               dependencies=[Depends(require_scope("admin"))])
async def unpair(
    device_id: str,
    identity: Identity = Depends(require_scope("admin")),
) -> dict:
    ws = UUID(identity.workspace_id)
    async with pool().acquire() as conn:
        result = await conn.execute(
            "DELETE FROM devices WHERE id = $1 AND workspace_id = $2",
            UUID(device_id), ws,
        )
    return {"deleted": int(result.rsplit(" ", 1)[-1])}
