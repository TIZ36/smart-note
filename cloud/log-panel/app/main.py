"""SmartNote Cloud — Log Query Panel (developer tool).

Internal devops surface, deliberately unauthenticated. Reads
pipeline_events directly from Postgres so engineers can grep across
ALL workspaces' run history without touching the public API. Think
SLS-Log / Grafana-Loki for SmartNote's pipeline.

Not for end users. Deploy on an internal network only — there is no
auth here on purpose; the security boundary is "is this port reachable
from outside the dev VPC".

Endpoints:
  GET  /                     SPA shell
  GET  /health               liveness + connection check
  GET  /api/recent_runs      most recent runs across all workspaces
  GET  /api/runs/{run_id}    full event chain for one run
  GET  /api/search           free-form filter (q, stage, status, ws, doc, since/until)
  GET  /api/workspaces       distinct workspaces with recent activity
  GET  /api/stats            roll-up counters for the home dashboard
"""

from __future__ import annotations

import json
import logging
import os
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import UUID

import asyncpg
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s: %(message)s")
log = logging.getLogger("log-panel")

DATABASE_URL = os.environ.get("DATABASE_URL", "")
PANEL_PORT = int(os.environ.get("PANEL_PORT", "8090"))


def _normalize_dsn(url: str) -> str:
    return url.replace("postgresql+asyncpg://", "postgresql://", 1)


_pool: asyncpg.Pool | None = None


async def _init_conn(conn: asyncpg.Connection) -> None:
    """Match cloud-api's codec setup (cloud/api/app/common/db.py).

    Without this, asyncpg returns JSONB columns as raw text — calls
    like `data.get("cost_usd")` later in the rollup paths crash
    with AttributeError, surfacing as a 500 on /api/runs/{id} and
    /api/recent_runs in the panel.
    """
    await conn.set_type_codec(
        "jsonb",
        encoder=json.dumps,
        decoder=json.loads,
        schema="pg_catalog",
    )
    await conn.set_type_codec(
        "json",
        encoder=json.dumps,
        decoder=json.loads,
        schema="pg_catalog",
    )


@asynccontextmanager
async def _lifespan(app: FastAPI):
    global _pool
    if not DATABASE_URL:
        log.warning("DATABASE_URL not set — panel will run but every query will 503")
        yield
        return
    _pool = await asyncpg.create_pool(
        _normalize_dsn(DATABASE_URL),
        min_size=1,
        max_size=4,
        command_timeout=15.0,
        init=_init_conn,
    )
    log.info("connected to %s", DATABASE_URL.split("@")[-1])
    try:
        yield
    finally:
        if _pool:
            await _pool.close()


app = FastAPI(title="SmartNote · Log Panel", lifespan=_lifespan)

STATIC_DIR = Path(__file__).parent.parent / "static"
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.get("/")
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/health")
async def health() -> dict[str, Any]:
    pool_ok = False
    if _pool:
        try:
            async with _pool.acquire() as conn:
                await conn.fetchval("SELECT 1")
            pool_ok = True
        except Exception:
            pool_ok = False
    return {
        "status": "ok" if pool_ok else "degraded",
        "db_configured": bool(DATABASE_URL),
        "db_connected": pool_ok,
    }


def _require_pool() -> asyncpg.Pool:
    if _pool is None:
        raise HTTPException(503, "log-panel DB not configured")
    return _pool


def _row_to_event(r: Any) -> dict[str, Any]:
    # `data` should always be a dict thanks to the jsonb codec set
    # up in _init_conn — but in case the codec didn't apply (older
    # asyncpg / a server with no jsonb type), handle string + None
    # gracefully so a single bad row doesn't 500 the whole route.
    raw_data = r["data"]
    if isinstance(raw_data, str):
        try:
            data = json.loads(raw_data)
            if not isinstance(data, dict):
                data = {}
        except Exception:
            data = {}
    elif isinstance(raw_data, dict):
        data = raw_data
    else:
        data = {}
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
        "data": data,
    }


@app.get("/api/recent_runs")
async def recent_runs(
    workspace_id: str | None = Query(None),
    limit: int = Query(50, ge=1, le=200),
) -> dict[str, Any]:
    """Most recently active runs across (optionally filtered by) workspace."""
    pool = _require_pool()
    where = ["run_id IS NOT NULL"]
    args: list[Any] = []
    if workspace_id:
        try:
            args.append(UUID(workspace_id))
            where.append(f"workspace_id = ${len(args)}")
        except ValueError:
            raise HTTPException(400, "invalid workspace_id")
    args.append(limit)
    sql = f"""
        WITH ranked AS (
          SELECT
            run_id,
            workspace_id,
            document_id,
            stage,
            MAX(at)  AS last_at,
            MIN(at)  AS first_at,
            COUNT(*) AS event_count,
            MAX(status) FILTER (WHERE status IN ('done','failed','partial','skipped')) AS terminal_status
          FROM pipeline_events
          WHERE {' AND '.join(where)}
          GROUP BY run_id, workspace_id, document_id, stage
        )
        SELECT * FROM ranked
        ORDER BY last_at DESC
        LIMIT ${len(args)}
    """
    async with pool.acquire() as conn:
        rows = await conn.fetch(sql, *args)
    out = []
    for r in rows:
        duration_ms = None
        if r["first_at"] and r["last_at"]:
            duration_ms = int((r["last_at"] - r["first_at"]).total_seconds() * 1000)
        out.append({
            "run_id": str(r["run_id"]),
            "workspace_id": str(r["workspace_id"]),
            "document_id": str(r["document_id"]) if r["document_id"] else None,
            "stage": r["stage"],
            "started_at": r["first_at"].astimezone(timezone.utc).isoformat() if r["first_at"] else None,
            "finished_at": r["last_at"].astimezone(timezone.utc).isoformat() if r["last_at"] else None,
            "duration_ms": duration_ms,
            "event_count": int(r["event_count"]),
            "status": r["terminal_status"] or "running",
        })
    return {"runs": out, "count": len(out)}


@app.get("/api/runs/{run_id}")
async def get_run_chain(run_id: str) -> dict[str, Any]:
    pool = _require_pool()
    try:
        run_uuid = UUID(run_id)
    except ValueError:
        raise HTTPException(400, "invalid run_id")
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT id, at, workspace_id, run_id, document_id, stage, event,
                   status, message, error, schema_version, data
            FROM pipeline_events
            WHERE run_id=$1
            ORDER BY at ASC, id ASC
            """,
            run_uuid,
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
    status: str | None = None
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
    return {
        "run_id": run_id,
        "workspace_id": str(rows[0]["workspace_id"]),
        "document_id": events[0]["document_id"],
        "stage": events[0]["stage"],
        "started_at": started_at,
        "finished_at": finished_at,
        "duration_ms": duration_ms,
        "status": status,
        "cost_usd": cost_usd,
        "model": model,
        "events": events,
    }


@app.get("/api/search")
async def search(
    workspace_id: str | None = Query(None),
    document_id: str | None = Query(None),
    stage: str | None = Query(None),
    status: str | None = Query(None),
    q: str | None = Query(None, description="substring on event/message/error"),
    since: str | None = Query(None),
    until: str | None = Query(None),
    limit: int = Query(200, ge=1, le=1000),
    cursor: int | None = Query(None),
) -> dict[str, Any]:
    pool = _require_pool()
    where: list[str] = []
    args: list[Any] = []

    def add(cond: str, val: Any) -> None:
        args.append(val)
        where.append(cond.replace("?", f"${len(args)}"))

    if workspace_id:
        try: add("workspace_id = ?", UUID(workspace_id))
        except ValueError: raise HTTPException(400, "invalid workspace_id")
    if document_id:
        try: add("document_id = ?", UUID(document_id))
        except ValueError: raise HTTPException(400, "invalid document_id")
    if stage:  add("stage = ?", stage)
    if status: add("status = ?", status)
    if since:
        try: add("at >= ?", datetime.fromisoformat(since.replace("Z", "+00:00")))
        except ValueError: raise HTTPException(400, "invalid 'since'")
    if until:
        try: add("at < ?", datetime.fromisoformat(until.replace("Z", "+00:00")))
        except ValueError: raise HTTPException(400, "invalid 'until'")
    if q:
        # Three-way ILIKE on event / message / error against the same value
        args.append(f"%{q}%")
        idx = len(args)
        where.append(
            f"(event ILIKE ${idx} OR message ILIKE ${idx} OR error ILIKE ${idx})"
        )
    if cursor is not None:
        add("id < ?", int(cursor))

    where_sql = ("WHERE " + " AND ".join(where)) if where else ""
    sql = f"""
        SELECT id, at, workspace_id, run_id, document_id, stage, event,
               status, message, error, schema_version, data
        FROM pipeline_events
        {where_sql}
        ORDER BY id DESC
        LIMIT {int(limit)}
    """
    async with pool.acquire() as conn:
        rows = await conn.fetch(sql, *args)
    events = [_row_to_event(r) for r in rows]
    next_cursor = events[-1]["id"] if events and len(events) >= limit else None
    return {"events": events, "next_cursor": next_cursor, "count": len(events)}


@app.get("/api/workspaces")
async def workspaces(limit: int = Query(50, ge=1, le=500)) -> dict[str, Any]:
    """Distinct workspaces with recent activity. Powers the workspace
    filter dropdown in the panel."""
    pool = _require_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT
              workspace_id,
              MAX(at)  AS last_at,
              COUNT(*) AS events
            FROM pipeline_events
            GROUP BY workspace_id
            ORDER BY last_at DESC
            LIMIT $1
            """,
            limit,
        )
    return {
        "workspaces": [
            {
                "workspace_id": str(r["workspace_id"]),
                "last_at": r["last_at"].astimezone(timezone.utc).isoformat() if r["last_at"] else None,
                "events": int(r["events"]),
            }
            for r in rows
        ]
    }


@app.get("/api/stats")
async def stats() -> dict[str, Any]:
    """Top-of-panel roll-up: total events / runs / errors today,
    distinct workspaces seen, total LLM cost today."""
    pool = _require_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT
              COUNT(*)                                              AS events_total,
              COUNT(*) FILTER (WHERE at >= now() - interval '24 hours') AS events_24h,
              COUNT(DISTINCT run_id)                                AS runs_total,
              COUNT(DISTINCT run_id) FILTER (WHERE at >= now() - interval '24 hours') AS runs_24h,
              COUNT(*) FILTER (WHERE status = 'failed' AND at >= now() - interval '24 hours') AS errors_24h,
              COUNT(DISTINCT workspace_id) FILTER (WHERE at >= now() - interval '24 hours') AS workspaces_24h,
              COALESCE(SUM(((data->>'cost_usd')::float8))
                       FILTER (WHERE at >= now() - interval '24 hours'
                               AND data ? 'cost_usd'), 0)           AS cost_24h_usd
            FROM pipeline_events
            """
        )
    return {
        "events_total":   int(row["events_total"]   or 0),
        "events_24h":     int(row["events_24h"]     or 0),
        "runs_total":     int(row["runs_total"]     or 0),
        "runs_24h":       int(row["runs_24h"]       or 0),
        "errors_24h":     int(row["errors_24h"]     or 0),
        "workspaces_24h": int(row["workspaces_24h"] or 0),
        "cost_24h_usd":   float(row["cost_24h_usd"] or 0.0),
    }
