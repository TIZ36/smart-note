/**
 * Pipeline event emitter — writes to pipeline_events AND broadcasts
 * the same payload to the renderer via the existing
 * `smartnote:ws-event` IPC channel.
 *
 * Why reuse the WS channel? The renderer's App.tsx already bridges
 * those events into custom DOM events
 * (`smartnote:doc-pipeline-changed` etc.) — every UI surface that
 * listens for live updates already works. Local mode is just a
 * different *source* of events; the wire format and renderer-side
 * bridge stay identical.
 *
 * Payload shape mirrors cloud/api/app/services/realtime_protocol.py
 * `event_payload(...)`. Anything that lands in `data` is the
 * structured per-stage telemetry (cost_usd, model, tokens, etc.).
 */

import { db, toJson } from "./db.mjs";
import { BrowserWindow } from "electron";

let _broadcastTo = null;
export function bindBroadcast(win) { _broadcastTo = win; }

export function emit({
  event,                     // chunk_embed_done | enrich_done | wiki_abstract_progress | note_classify_done | …
  document_id = null,
  run_id = null,
  stage = null,
  status = null,
  progress_current = null,
  progress_total = null,
  message = null,
  error = null,
  data = {},
  ...legacy                  // pass-through fields older renderer paths read directly
} = {}) {
  const at = Date.now();
  const payload = {
    type: event,
    event,
    schema_version: 1,
    at: new Date(at).toISOString(),
    workspace_id: "local",
    document_id,
    run_id,
    stage: stage || null,
    kind: stage || null,
    status,
    message,
    error,
    progress: progress_current != null || progress_total != null
      ? { current: Number(progress_current || 0), total: Number(progress_total || 0) }
      : undefined,
    data,
    ...legacy,
  };

  // Persist (best-effort — log + carry on if write fails).
  try {
    db().prepare(
      `INSERT INTO pipeline_events
        (run_id, document_id, stage, event, status, message, error, schema_version, data, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
    ).run(
      run_id || null,
      document_id || null,
      stage || null,
      event,
      status || null,
      message || null,
      error || null,
      toJson({ ...data, ...(payload.progress ? { progress: payload.progress } : {}) }),
      at,
    );
  } catch (e) {
    console.warn("[local-db.events] persist failed:", e?.message || e);
  }

  // Broadcast to renderer — same channel cloud mode uses, so the
  // existing App.tsx → CustomEvent bridge picks it up unchanged.
  try {
    const wins = _broadcastTo
      ? [_broadcastTo]
      : BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
    for (const w of wins) {
      w.webContents.send("smartnote:ws-event", payload);
    }
  } catch (e) {
    console.warn("[local-db.events] broadcast failed:", e?.message || e);
  }
}

/** Insert a new processing_runs row + emit `_started` event. Returns run_id. */
export function startRun({ kind, document_id, executor = "inline" }) {
  const id = cryptoRandomUUID();
  const at = Date.now();
  db().prepare(
    `INSERT INTO processing_runs (id, document_id, kind, status, executor, created_at, started_at)
     VALUES (?, ?, ?, 'running', ?, ?, ?)`,
  ).run(id, document_id, kind, executor, at, at);
  emit({
    event: `${kind}_started`,
    document_id,
    run_id: id,
    stage: kind,
    status: "running",
  });
  return id;
}

export function finishRun({ run_id, status = "done", result = null, error = null }) {
  const at = Date.now();
  db().prepare(
    `UPDATE processing_runs
     SET status = ?, result = ?, error = ?, finished_at = ?
     WHERE id = ?`,
  ).run(status, result ? toJson(result) : null, error || null, at, run_id);
}

function cryptoRandomUUID() {
  // Node's built-in is in `crypto`; keep import lazy so this file
  // stays importable from contexts where node:crypto isn't.
  const { randomUUID } = require("node:crypto");
  return randomUUID();
}
