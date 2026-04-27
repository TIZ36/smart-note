"""Device pairing + registry — `/v1/devices`.

Apple-TV-style pairing flow:
  * Existing (admin-scoped) device  →  POST /v1/devices/pair
      → returns a 6-digit code, valid 10 minutes.
  * Brand-new device, NO API key yet  →  POST /v1/devices/claim
      → trades the code for a fresh api_key bound to the workspace.
      Endpoint is intentionally unauthenticated: the new device has
      nothing else to authenticate with. Security comes from
      (a) the code being short-lived and globally unique (UNIQUE index
      in 009_devices.sql), and (b) the existing device only issuing
      a code when an authenticated admin asks for it.

Other endpoints stay admin-scoped:
  * GET  /v1/devices            — list this workspace's devices
  * POST /v1/devices/{id}/promote — make this device the primary
  * DELETE /v1/devices/{id}     — unpair (revokes the device's api_key)

Realtime status (online/offline) comes from `ws_registry`; not persisted.
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
from app.services.account.security import mint_api_key

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


class ClaimResponse(BaseModel):
    # The full `sn_live_..._...` secret — shown ONCE; the cloud only
    # stores its hash. The desktop persists this in settings as
    # `cloud_sync_api_key` and uses it for all future calls.
    api_key: str
    workspace_id: str
    device: DeviceOut


# Default scopes a paired device gets. We include `admin` so the new
# device can in turn pair *another* device without the user having to
# reach back to the original device — common case is a user pairing
# laptop, then phone, then tablet without a "primary" being singled out.
# If you want to harden this later, drop `admin` and add a separate
# "guest device" claim variant.
_DEVICE_SCOPES: list[str] = [
    "memories:read", "memories:write",
    "documents:read", "documents:write", "documents:ingest",
    "retrieve",
    "admin",
]


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


@router.post("/claim", response_model=ClaimResponse)
async def claim_device(req: ClaimRequest) -> ClaimResponse:
    """Redeem a pairing code → a fresh api_key for this workspace.

    Unauthenticated by design — the new device has nothing else to
    authenticate with. The pairing code is the credential, single-use
    and expires in `PAIRING_TTL_MIN` minutes. Look up by code alone
    (the partial UNIQUE index `idx_devices_pairing_code` makes this
    safe across all workspaces).
    """
    if not req.pairing_code.strip():
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "pairing_code required")
    new_key = mint_api_key()
    async with pool().acquire() as conn:
        async with conn.transaction():
            # Resolve the code → device row (single-use; clearing the
            # code in the same UPDATE prevents a second redemption).
            device_row = await conn.fetchrow(
                """
                UPDATE devices
                SET name = $2, platform = $3,
                    pairing_code = NULL, pairing_expires = NULL,
                    last_seen_at = now()
                WHERE pairing_code = $1
                  AND pairing_expires > now()
                RETURNING *
                """,
                req.pairing_code, req.name, req.platform,
            )
            if not device_row:
                raise HTTPException(
                    status.HTTP_404_NOT_FOUND, "invalid or expired code",
                )
            # Mint the api_key under the same workspace.
            await conn.execute(
                """
                INSERT INTO api_keys
                  (workspace_id, name, prefix, secret_hash, scopes,
                   agent_id, created_by, device_id)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                """,
                device_row["workspace_id"],
                f"device:{req.name}",
                new_key.prefix,
                new_key.secret_hash,
                _DEVICE_SCOPES,
                f"device:{req.platform}",
                "device-claim",
                device_row["id"],
            )
    return ClaimResponse(
        api_key=new_key.full_key,
        workspace_id=str(device_row["workspace_id"]),
        device=_row_to_out(device_row, online=False),
    )


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
    dev = UUID(device_id)
    async with pool().acquire() as conn:
        async with conn.transaction():
            # Revoke any api_keys this device claimed via /claim. The
            # device_id FK has ON DELETE SET NULL, so doing this in
            # the same tx prevents a window where the key still works
            # but the device row is gone.
            await conn.execute(
                "UPDATE api_keys SET revoked_at = now() "
                "WHERE device_id = $1 AND revoked_at IS NULL",
                dev,
            )
            result = await conn.execute(
                "DELETE FROM devices WHERE id = $1 AND workspace_id = $2",
                dev, ws,
            )
    return {"deleted": int(result.rsplit(" ", 1)[-1])}
