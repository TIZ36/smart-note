"""GET /v1/usage — current workspace's counters.

Exposed to any token with memories:read so agents can show usage in
their UI without needing admin scope. Monthly rows are not returned by
this endpoint — add a separate /v1/usage/history if the console wants
a chart later.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends

from app import usage as usage_module
from app.deps import Identity, require_scope

router = APIRouter(prefix="/v1/usage", tags=["usage"])


@router.get("", dependencies=[Depends(require_scope("memories:read"))])
async def current_usage(identity: Identity = Depends(require_scope("memories:read"))) -> dict:
    data = await usage_module.get(identity.workspace_id)
    return {"workspace_id": identity.workspace_id, **data}
