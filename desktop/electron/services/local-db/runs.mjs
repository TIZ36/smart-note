/**
 * Pipeline run lookups + the dispatcher that kicks off a stage.
 *
 * Day 1: lookups + dispatcher skeleton are real (so the renderer can
 * call /listRecentRuns / runStage / log queries against real data).
 * Day 2-3: the actual stage implementations land in ./pipeline/*.mjs
 * and get plugged into runStage()'s dispatch table.
 */

import { db, parseJson } from "./db.mjs";

/* ── recent runs (drives the tree state chips + Pipeline tab) ── */

export function listRecentRuns(limit = 50) {
  const rows = db().prepare(
    `SELECT pr.id, pr.document_id, pr.kind, pr.status, pr.executor, pr.error,
            pr.revision, pr.result, pr.created_at, pr.started_at, pr.finished_at,
            d.name AS document_name
     FROM processing_runs pr
     LEFT JOIN documents d ON d.id = pr.document_id
     ORDER BY pr.created_at DESC
     LIMIT ?`,
  ).all(limit);
  return rows.map((r) => ({
    id: r.id,
    document_id: r.document_id,
    document_name: r.document_name,
    kind: r.kind,
    status: r.status,
    executor: r.executor,
    error: r.error,
    revision: r.revision,
    result: parseJson(r.result, null),
    created_at: r.created_at ? new Date(r.created_at).toISOString() : null,
    started_at: r.started_at ? new Date(r.started_at).toISOString() : null,
    finished_at: r.finished_at ? new Date(r.finished_at).toISOString() : null,
  }));
}

/* ── stage dispatch ── kicks off a stage; the heavy work lives in
   ./pipeline/<stage>.mjs.  Day 1 returns 501 for stages whose
   pipeline module hasn't landed yet — Day 2-3 fill them in. */

export async function runStage({ document_id, kind, force = false }) {
  let mod;
  switch (kind) {
    case "chunk_embed":   mod = await import("./pipeline/chunk_embed.mjs").catch(() => null); break;
    case "ai_enrich":     mod = await import("./pipeline/ai_enrich.mjs").catch(() => null); break;
    case "wiki_abstract": mod = await import("./pipeline/wiki_abstract.mjs").catch(() => null); break;
    case "note_classify": mod = await import("./pipeline/note_classify.mjs").catch(() => null); break;
    default: throw new Error(`unknown kind: ${kind}`);
  }
  if (!mod || typeof mod.run !== "function") {
    // Stage not yet implemented (Day 1 stub).
    throw new Error(`stage '${kind}' not implemented in this build`);
  }
  return await mod.run({ document_id, force });
}

/* ── Logs channel queries — match cloud's /v1/logs surface ── */

export function recentRunsForLogs(limit = 50) {
  const rows = db().prepare(
    `WITH ranked AS (
       SELECT
         run_id,
         document_id,
         stage,
         MAX(at)  AS last_at,
         MIN(at)  AS first_at,
         COUNT(*) AS event_count,
         (SELECT status FROM pipeline_events pe2
           WHERE pe2.run_id = pe.run_id
             AND pe2.status IN ('done','failed','partial','skipped')
           ORDER BY pe2.at DESC LIMIT 1) AS terminal_status
       FROM pipeline_events pe
       WHERE run_id IS NOT NULL
       GROUP BY run_id, document_id, stage
     )
     SELECT * FROM ranked
     ORDER BY last_at DESC
     LIMIT ?`,
  ).all(limit);
  return {
    runs: rows.map((r) => ({
      run_id: r.run_id,
      workspace_id: "local",
      document_id: r.document_id,
      stage: r.stage,
      started_at: r.first_at ? new Date(r.first_at).toISOString() : null,
      finished_at: r.last_at ? new Date(r.last_at).toISOString() : null,
      duration_ms: r.first_at && r.last_at ? r.last_at - r.first_at : null,
      event_count: r.event_count,
      status: r.terminal_status || "running",
    })),
    count: rows.length,
  };
}

export function runChain(run_id) {
  const rows = db().prepare(
    `SELECT id, at, run_id, document_id, stage, event, status, message,
            error, schema_version, data
     FROM pipeline_events
     WHERE run_id = ?
     ORDER BY at ASC, id ASC`,
  ).all(run_id);
  if (!rows.length) {
    const e = new Error("run not found");
    e.status = 404;
    throw e;
  }
  const events = rows.map((r) => ({
    id: r.id,
    at: r.at ? new Date(r.at).toISOString() : null,
    workspace_id: "local",
    run_id: r.run_id,
    document_id: r.document_id,
    stage: r.stage,
    event: r.event,
    status: r.status,
    message: r.message,
    error: r.error,
    schema_version: r.schema_version,
    data: parseJson(r.data, {}),
  }));
  // Roll up
  let status = null, cost_usd = null, model = null;
  for (const ev of events) {
    if (["done", "failed", "partial", "skipped"].includes(ev.status)) status = ev.status;
    const c = ev.data?.cost_usd;
    if (typeof c === "number") cost_usd = (cost_usd || 0) + c;
    const m = ev.data?.model;
    if (typeof m === "string") model = m;
  }
  const started_at = events[0].at;
  const finished_at = events[events.length - 1].at;
  const duration_ms = started_at && finished_at
    ? new Date(finished_at).getTime() - new Date(started_at).getTime() : null;
  return {
    run_id,
    workspace_id: "local",
    document_id: events[0].document_id,
    stage: events[0].stage,
    started_at, finished_at, duration_ms,
    status, cost_usd, model,
    events,
  };
}

export function searchEvents({
  stage = null, status = null, document_id = null, q = null,
  since = null, until = null, limit = 200, cursor = null,
} = {}) {
  const where = ["1 = 1"];
  const args = [];
  if (stage) { where.push("stage = ?"); args.push(stage); }
  if (status) { where.push("status = ?"); args.push(status); }
  if (document_id) { where.push("document_id = ?"); args.push(document_id); }
  if (since) { where.push("at >= ?"); args.push(new Date(since).getTime()); }
  if (until) { where.push("at < ?"); args.push(new Date(until).getTime()); }
  if (q) {
    where.push("(event LIKE ? OR message LIKE ? OR error LIKE ?)");
    args.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  if (cursor != null) { where.push("id < ?"); args.push(Number(cursor)); }
  const sql = `SELECT id, at, run_id, document_id, stage, event, status,
                      message, error, schema_version, data
               FROM pipeline_events
               WHERE ${where.join(" AND ")}
               ORDER BY id DESC
               LIMIT ?`;
  args.push(limit);
  const rows = db().prepare(sql).all(...args);
  const events = rows.map((r) => ({
    id: r.id,
    at: r.at ? new Date(r.at).toISOString() : null,
    workspace_id: "local",
    run_id: r.run_id,
    document_id: r.document_id,
    stage: r.stage,
    event: r.event,
    status: r.status,
    message: r.message,
    error: r.error,
    schema_version: r.schema_version,
    data: parseJson(r.data, {}),
  }));
  const next_cursor = events.length >= limit ? events[events.length - 1].id : null;
  return { events, next_cursor, count: events.length };
}

export function statsRollup() {
  const r = db().prepare(
    `SELECT
       COUNT(*)                                                 AS events_total,
       COUNT(*) FILTER (WHERE at >= ?)                          AS events_24h,
       COUNT(DISTINCT run_id)                                   AS runs_total,
       COUNT(DISTINCT run_id) FILTER (WHERE at >= ?)            AS runs_24h,
       COUNT(*) FILTER (WHERE status = 'failed' AND at >= ?)    AS errors_24h
     FROM pipeline_events`,
  ).get(Date.now() - 86_400_000, Date.now() - 86_400_000, Date.now() - 86_400_000);
  // Cost roll-up: SQLite doesn't have jsonb operators, so iterate.
  const cost24 = db().prepare(
    `SELECT data FROM pipeline_events WHERE at >= ?`,
  ).all(Date.now() - 86_400_000)
   .map((r) => parseJson(r.data, {}))
   .filter((d) => typeof d.cost_usd === "number")
   .reduce((s, d) => s + d.cost_usd, 0);
  return {
    events_total:   r?.events_total   || 0,
    events_24h:     r?.events_24h     || 0,
    runs_total:     r?.runs_total     || 0,
    runs_24h:       r?.runs_24h       || 0,
    errors_24h:     r?.errors_24h     || 0,
    workspaces_24h: 1,
    cost_24h_usd:   cost24,
  };
}
