"""Pipeline event log query API.

Backs the standalone log query panel service (cloud/log-panel/) and
the in-app "Open in Logs ↗" affordance on the stage detail modal.

Reads from `pipeline_events` (migration 027). Every WS broadcast is
persisted there with run_id / stage / status / data — making the
full event chain replayable per run.

Endpoints:
  GET /v1/logs/runs/{run_id}                full chain for a single run
  GET /v1/logs/search?...                   workspace-scoped search

Auth: every read is scoped to the caller's workspace via require_scope
("read:logs" — falls back to read:memories if logs scope is absent so
existing keys aren't broken before scope rotation).
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from app.db import pool
from app.deps import Identity, require_any_scope


router = APIRouter(prefix="/v1/logs", tags=["logs"])


def _row_to_event(r: Any) -> dict[str, Any]:
    """Translate an asyncpg row to the wire shape. Mirrors the WS
    payload envelope so log clients can render the same way as live
    consumers."""
    return {
        "id": r["id"],
        "at": r["at"].astimezone(timezone.utc).isoformat() if r["at"] else None,
        "workspace_id": str(r["workspace_id"]) if r["workspace_id"] else None,
        "run_id": str(r["run_id"]) if r["run_id"] else None,
        "document_id": str(r["document_id"]) if r["document_id"] else None,
        "stage": r["stage"],
        "event": r["event"],
        "status": r["status"],
        "message": r["message"],
        "error": r["error"],
        "schema_version": r["schema_version"],
        "data": r["data"] or {},
    }


class RunChain(BaseModel):
    run_id: str
    workspace_id: str
    document_id: str | None
    stage: str | None
    started_at: str | None
    finished_at: str | None
    duration_ms: int | None
    status: str | None
    cost_usd: float | None
    model: str | None
    events: list[dict[str, Any]]


@router.get("/runs/{run_id}", response_model=RunChain)
async def get_run_chain(
    run_id: str,
    identity: Identity = Depends(require_any_scope("read:logs", "read:memories")),
) -> RunChain:
    """Full event chain for one run_id, plus a roll-up of the
    derived totals (status/cost/duration) callers need without
    walking the chain themselves."""
    try:
        run_uuid = UUID(run_id)
    except (TypeError, ValueError):
        raise HTTPException(400, "invalid run_id")

    p = pool()
    async with p.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT id, at, workspace_id, run_id, document_id, stage, event,
                   status, message, error, schema_version, data
            FROM pipeline_events
            WHERE run_id=$1 AND workspace_id=$2
            ORDER BY at ASC, id ASC
            """,
            run_uuid,
            UUID(identity.workspace_id),
        )

    if not rows:
        raise HTTPException(404, "run not found")

    events = [_row_to_event(r) for r in rows]
    started_at = events[0]["at"]
    finished_at = events[-1]["at"]
    duration_ms = None
    if started_at and finished_at:
        try:
            t0 = datetime.fromisoformat(started_at.replace("Z", "+00:00"))
            t1 = datetime.fromisoformat(finished_at.replace("Z", "+00:00"))
            duration_ms = int((t1 - t0).total_seconds() * 1000)
        except Exception:
            duration_ms = None

    # Roll up: pick the latest meaningful status; sum cost across events
    # (typically only a single done event carries cost_usd).
    status = None
    cost_usd: float | None = None
    model: str | None = None
    for ev in events:
        if ev["status"] in ("done", "failed", "partial", "skipped"):
            status = ev["status"]
        d = ev.get("data") or {}
        if isinstance(d.get("cost_usd"), (int, float)):
            cost_usd = (cost_usd or 0.0) + float(d["cost_usd"])
        if isinstance(d.get("model"), str):
            model = d["model"]

    return RunChain(
        run_id=run_id,
        workspace_id=str(rows[0]["workspace_id"]),
        document_id=events[0]["document_id"],
        stage=events[0]["stage"],
        started_at=started_at,
        finished_at=finished_at,
        duration_ms=duration_ms,
        status=status,
        cost_usd=cost_usd,
        model=model,
        events=events,
    )


@router.get("/search")
async def search(
    identity: Identity = Depends(require_any_scope("read:logs", "read:memories")),
    stage: str | None = Query(None),
    status: str | None = Query(None),
    document_id: str | None = Query(None),
    q: str | None = Query(None, description="substring match on message/error/event"),
    since: str | None = Query(None, description="ISO 8601; events at-or-after"),
    until: str | None = Query(None, description="ISO 8601; events strictly before"),
    limit: int = Query(100, ge=1, le=500),
    cursor: int | None = Query(None, description="last id from previous page"),
) -> dict[str, Any]:
    """Workspace-scoped paginated search over pipeline_events. Cursor
    is the last `id` from the prior page (id is monotonic) — simple
    and stable, no offset overflow.
    """
    where = ["workspace_id = $1"]
    args: list[Any] = [UUID(identity.workspace_id)]

    def add(cond: str, val: Any) -> None:
        args.append(val)
        where.append(cond.replace("?", f"${len(args)}"))

    if stage:
        add("stage = ?", stage)
    if status:
        add("status = ?", status)
    if document_id:
        try:
            add("document_id = ?", UUID(document_id))
        except ValueError:
            raise HTTPException(400, "invalid document_id")
    if since:
        try:
            add("at >= ?", datetime.fromisoformat(since.replace("Z", "+00:00")))
        except ValueError:
            raise HTTPException(400, "invalid 'since'")
    if until:
        try:
            add("at < ?", datetime.fromisoformat(until.replace("Z", "+00:00")))
        except ValueError:
            raise HTTPException(400, "invalid 'until'")
    if q:
        # ILIKE on event/message/error — composite, but each is short
        add("(event ILIKE ? OR message ILIKE ? OR error ILIKE ?)", f"%{q}%")
        # The single ? above pulled one $N; we need two more for the same value
        args.append(f"%{q}%")
        args.append(f"%{q}%")
        # Replace the single placeholder with three positional spans
        where[-1] = (
            f"(event ILIKE ${len(args)-2} OR "
            f"message ILIKE ${len(args)-1} OR "
            f"error ILIKE ${len(args)})"
        )
    if cursor is not None:
        add("id < ?", int(cursor))

    sql = f"""
        SELECT id, at, workspace_id, run_id, document_id, stage, event,
               status, message, error, schema_version, data
        FROM pipeline_events
        WHERE {' AND '.join(where)}
        ORDER BY id DESC
        LIMIT {int(limit)}
    """

    p = pool()
    async with p.acquire() as conn:
        rows = await conn.fetch(sql, *args)

    events = [_row_to_event(r) for r in rows]
    next_cursor = events[-1]["id"] if events and len(events) >= limit else None
    return {"events": events, "next_cursor": next_cursor, "count": len(events)}


@router.get("/recent_runs")
async def recent_runs(
    identity: Identity = Depends(require_any_scope("read:logs", "read:memories")),
    limit: int = Query(50, ge=1, le=200),
) -> dict[str, Any]:
    """Distinct recent run_ids in this workspace, with a one-row
    summary each. Powers the log panel's home view ("what ran
    today?"). Cheap because pipeline_events is indexed by run_id.
    """
    p = pool()
    async with p.acquire() as conn:
        rows = await conn.fetch(
            """
            WITH ranked AS (
              SELECT
                run_id,
                document_id,
                stage,
                MAX(at)  AS last_at,
                MIN(at)  AS first_at,
                COUNT(*) AS event_count,
                MAX(status) FILTER (WHERE status IN ('done','failed','partial','skipped')) AS terminal_status
              FROM pipeline_events
              WHERE workspace_id = $1 AND run_id IS NOT NULL
              GROUP BY run_id, document_id, stage
            )
            SELECT * FROM ranked
            ORDER BY last_at DESC
            LIMIT $2
            """,
            UUID(identity.workspace_id),
            limit,
        )

    out = []
    for r in rows:
        duration_ms = None
        if r["first_at"] and r["last_at"]:
            duration_ms = int((r["last_at"] - r["first_at"]).total_seconds() * 1000)
        out.append({
            "run_id": str(r["run_id"]),
            "document_id": str(r["document_id"]) if r["document_id"] else None,
            "stage": r["stage"],
            "started_at": r["first_at"].astimezone(timezone.utc).isoformat() if r["first_at"] else None,
            "finished_at": r["last_at"].astimezone(timezone.utc).isoformat() if r["last_at"] else None,
            "duration_ms": duration_ms,
            "event_count": int(r["event_count"]),
            "status": r["terminal_status"] or "running",
        })
    return {"runs": out, "count": len(out)}
