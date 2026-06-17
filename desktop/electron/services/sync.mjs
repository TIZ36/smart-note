/* File watcher + cloud sync push.
 *
 * Replaces server/app/cloud_sync.py + the chunk of gateway.py that
 * watched the notes dir for changes. The Node version is dramatically
 * smaller because it leans on chokidar (no manual polling) and the
 * cloud already owns enrich + embedding.
 *
 * Lifecycle:
 *   start()   — read settings, spin up watcher + initial scan
 *   stop()    — close watcher, drop pending debounces
 *   status()  — what's it doing right now (consumed by Cloud Console)
 *
 * Safety: a single in-flight push per file (debounced 500ms).
 * Failures back off (we don't retry hard — the next mtime change
 * re-queues). The local FTS index gets re-indexed on every change so
 * offline search stays fresh.
 */
import chokidar from "chokidar";
import { promises as fs } from "node:fs";
import path from "node:path";
import * as settings from "./settings.mjs";
import * as localSearch from "./local-search.mjs";

let _watcher = null;
let _state = {
  running: false,
  notes_dir: null,
  cloud_url: null,
  watched_files: 0,
  last_push_at: null,
  last_error: null,
  pending: 0,
  conflicts: [],            // [{ relPath, docId, cloudMs, by }]
};

const _debounce = new Map();          // rel_path → setTimeout
const _inflight = new Set();          // rel_path with active fetch

// Per-file "last cloud version we successfully observed". Used as the
// optimistic-concurrency baseline before every PATCH so an MCP-side or
// other-device edit isn't silently clobbered.
const _lastSeenCloudMs = new Map();   // rel_path → epoch ms
const _conflicted      = new Set();   // rel_path with unresolved conflict

// Conflict listener — wired from main.mjs so the renderer can show a
// banner / toast when the watcher refuses to push a clobber.
let _onConflict = null;
export function setOnConflict(fn) { _onConflict = fn; }
function _emitConflict(info) {
  _conflicted.add(info.relPath);
  _state.conflicts = Array.from(_conflicted);
  _state.last_error = `cloud has newer changes for ${info.relPath} — open the note to merge`;
  if (typeof _onConflict === "function") {
    try { _onConflict(info); } catch {}
  }
}

// Cleared by NotePage after a successful merge-then-push so the
// watcher can resume auto-syncing this file.
export function clearConflict(relPath, newCloudMs) {
  _conflicted.delete(relPath);
  if (typeof newCloudMs === "number") _lastSeenCloudMs.set(relPath, newCloudMs);
  _state.conflicts = Array.from(_conflicted);
}

async function _jwt(cloudUrl, apiKey) {
  const r = await fetch(`${cloudUrl}/v1/auth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: apiKey }),
  });
  if (!r.ok) throw new Error(`auth: ${r.status}`);
  const d = await r.json();
  return d.jwt;
}

async function _pushFile(relPath, absPath, jwt, cloudUrl) {
  const content = await fs.readFile(absPath, "utf8");
  await localSearch.indexFile(relPath, content);
  const nowIso = new Date().toISOString();
  // Upsert by metadata.local_path — first push creates, subsequent
  // pushes PATCH the same doc's content. Earlier behaviour stamped
  // every push with a __YYYY-MM-DD_HHMMSS suffix, fragmenting the
  // workspace into N copies of the same note and breaking retrieval
  // (vec scoring competed across stale + fresh duplicates).
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${jwt}`,
  };
  const baseMeta = {
    smartnote_type: "note",
    local_path: relPath,
    original_name: relPath,
    synced_at: nowIso,
    source: "auto-sync",
  };
  // Find existing doc with the same local_path so we update it.
  let existingId = null;
  let existingMeta = {};
  try {
    const list = await fetch(
      `${cloudUrl}/v1/documents?smartnote_type=note`,
      { headers },
    );
    if (list.ok) {
      const j = await list.json();
      const docs = (j && j.documents) || [];
      const match = docs.find((d) =>
        d?.metadata && typeof d.metadata === "object"
          && d.metadata.local_path === relPath,
      );
      if (match) {
        existingId = match.id;
        existingMeta = match.metadata && typeof match.metadata === "object" ? match.metadata : {};
      }
    }
  } catch { /* fall through to create */ }

  const filename = relPath.split("/").pop() || relPath;
  if (existingId) {
    // ── Optimistic-concurrency guard ─────────────────────────────
    // If the cloud doc was modified (by MCP, another desktop, the
    // console — anything other than this watcher's previous push)
    // since we last observed it, refuse to PATCH. Otherwise we'd
    // silently clobber that change.
    const serverMs = typeof existingMeta.cloud_content_updated_at_ms === "number"
      ? existingMeta.cloud_content_updated_at_ms
      : 0;
    const seenMs = _lastSeenCloudMs.get(relPath) ?? 0;
    if (serverMs > seenMs) {
      _emitConflict({
        relPath,
        docId: existingId,
        cloudMs: serverMs,
        by: existingMeta.cloud_content_updated_by || "cloud",
      });
      // Don't throw — surface as a conflict, not an exception. The
      // next file save will re-attempt and stay blocked until the
      // renderer calls clearConflict (= the user merged).
      return null;
    }

    const r = await fetch(`${cloudUrl}/v1/documents/${existingId}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        name: filename,
        content,
        metadata: {
          ...existingMeta,
          ...baseMeta,
          local_content_updated_at_ms: Date.now(),
        },
      }),
    });
    if (!r.ok) throw new Error(`patch ${relPath}: ${r.status}`);
    const body = await r.json();
    // Record the post-PATCH cloud version as the new baseline so
    // legitimate cloud updates between our pushes are still detected.
    const newMs = body?.metadata?.cloud_content_updated_at_ms;
    if (typeof newMs === "number") _lastSeenCloudMs.set(relPath, newMs);
    return body;
  }

  const r = await fetch(`${cloudUrl}/v1/documents`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: filename,
      content,
      kind: "markdown",
      metadata: {
        ...baseMeta,
        local_content_updated_at_ms: Date.now(),
      },
    }),
  });
  if (!r.ok) throw new Error(`push ${relPath}: ${r.status}`);
  const body = await r.json();
  const newMs = body?.metadata?.cloud_content_updated_at_ms;
  if (typeof newMs === "number") _lastSeenCloudMs.set(relPath, newMs);
  return body;
}

function _schedulePush(relPath, absPath) {
  if (_debounce.has(relPath)) clearTimeout(_debounce.get(relPath));
  _state.pending = _debounce.size + 1;
  _debounce.set(relPath, setTimeout(async () => {
    _debounce.delete(relPath);
    if (_inflight.has(relPath)) return;
    // Skip the push entirely while a conflict is unresolved. The next
    // attempt also won't push (still conflicted) until clearConflict()
    // is called from NotePage's merge flow.
    if (_conflicted.has(relPath)) {
      _state.pending = _debounce.size + _inflight.size;
      return;
    }
    _inflight.add(relPath);
    try {
      const s = await settings.read();
      if (!s.cloud_sync_url || !s.cloud_sync_api_key) {
        // Cloud not configured — index locally only.
        const content = await fs.readFile(absPath, "utf8");
        await localSearch.indexFile(relPath, content);
        return;
      }
      const jwt = await _jwt(
        s.cloud_sync_url.replace(/\/+$/, ""),
        s.cloud_sync_api_key,
      );
      await _pushFile(relPath, absPath, jwt, s.cloud_sync_url.replace(/\/+$/, ""));
      _state.last_push_at = Date.now();
      _state.last_error = null;
    } catch (e) {
      _state.last_error = String(e);
    } finally {
      _inflight.delete(relPath);
      _state.pending = _debounce.size + _inflight.size;
    }
  }, 500));
}

export async function start() {
  if (_watcher) return _state;
  const s = await settings.read();
  if (!s.notes_dir) throw new Error("notes_dir not set");
  const root = path.resolve(s.notes_dir);
  _state.notes_dir = root;
  _state.cloud_url = s.cloud_sync_url || null;

  // Pre-populate the per-file baseline from cloud so the very first
  // PATCH after start can detect drift (MCP edits made while desktop
  // was closed). Best-effort — if cloud isn't reachable we fall back
  // to "no baseline" and the first push will write through.
  if (s.cloud_sync_url && s.cloud_sync_api_key) {
    try {
      const url = s.cloud_sync_url.replace(/\/+$/, "");
      const jwt = await _jwt(url, s.cloud_sync_api_key);
      const list = await fetch(`${url}/v1/documents?smartnote_type=note`, {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      if (list.ok) {
        const j = await list.json();
        for (const d of (j?.documents || [])) {
          const lp = d?.metadata?.local_path;
          const ms = d?.metadata?.cloud_content_updated_at_ms;
          if (typeof lp === "string" && typeof ms === "number") {
            _lastSeenCloudMs.set(lp, ms);
          }
        }
      }
    } catch { /* baseline best-effort */ }
  }

  _watcher = chokidar.watch(root, {
    ignored: (p) => /\/\..*/.test(p),
    persistent: true,
    ignoreInitial: false,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
  });

  _watcher
    .on("add", (abs) => {
      if (!/\.(md|markdown|txt)$/i.test(abs)) return;
      _state.watched_files++;
      _schedulePush(path.relative(root, abs), abs);
    })
    .on("change", (abs) => {
      if (!/\.(md|markdown|txt)$/i.test(abs)) return;
      _schedulePush(path.relative(root, abs), abs);
    })
    .on("unlink", async (abs) => {
      if (!/\.(md|markdown|txt)$/i.test(abs)) return;
      _state.watched_files = Math.max(0, _state.watched_files - 1);
      try { await localSearch.removeFile(path.relative(root, abs)); } catch {}
    });

  _state.running = true;
  return _state;
}

export async function stop() {
  for (const t of _debounce.values()) clearTimeout(t);
  _debounce.clear();
  if (_watcher) { await _watcher.close(); _watcher = null; }
  _state.running = false;
  return _state;
}

export function status() { return { ..._state }; }

// ── Device heartbeat ─────────────────────────────────────────────
// Independent of the file watcher: the desktop pings cloud every
// 30s so devices.last_seen_at stays fresh. Used by the workspace
// registry to render an honest online indicator. Without this the
// JWT cache (hour-long TTL) would let a sitting desktop go "offline"
// within 60s of last token exchange.
const HEARTBEAT_MS = 30_000;
let _heartbeatTimer = null;
let _heartbeatJwt = null;  // { jwt, expiresAt, key } cache

async function _heartbeatJwtFor(cloudUrl, apiKey) {
  const now = Math.floor(Date.now() / 1000);
  if (_heartbeatJwt && _heartbeatJwt.key === apiKey && _heartbeatJwt.expiresAt - 60 > now) {
    return _heartbeatJwt.jwt;
  }
  const r = await fetch(`${cloudUrl}/v1/auth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: apiKey }),
  });
  if (!r.ok) throw new Error(`auth: ${r.status}`);
  const d = await r.json();
  _heartbeatJwt = { jwt: d.jwt, expiresAt: d.expires_at, key: apiKey };
  return d.jwt;
}

async function _tickHeartbeat() {
  try {
    const s = await settings.read();
    if (!s.cloud_sync_url || !s.cloud_sync_api_key) return;
    const cloudUrl = s.cloud_sync_url.replace(/\/+$/, "");
    const jwt = await _heartbeatJwtFor(cloudUrl, s.cloud_sync_api_key);
    await fetch(`${cloudUrl}/v1/devices/heartbeat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${jwt}`,
      },
    }).catch(() => {});
  } catch {
    /* heartbeat is best-effort — never error-flash the UI */
  }
}

export function startHeartbeat() {
  if (_heartbeatTimer) return;
  // First ping immediately so a freshly-started desktop appears
  // online without waiting 30s for the first interval tick.
  _tickHeartbeat();
  _heartbeatTimer = setInterval(_tickHeartbeat, HEARTBEAT_MS);
}

// In-process device-source markers — set by this desktop's writers so
// we can tell our own round-trip WS echoes from foreign edits (MCP,
// console, another desktop). Anything NOT in this set is treated as
// foreign, which is the safe default — undefined → conflict.
const SELF_SOURCES = new Set(["auto-sync", "note-editor"]);

// Called from main.mjs once ws-presence is up. Keeps the per-file
// baseline coherent with cloud reality:
//   - Echo of our own push  → bump baseline so the next watcher push
//                             to this file doesn't false-conflict.
//   - Foreign edit (MCP/…)  → DON'T bump baseline (local file is now
//                             out-of-date), AND mark conflict so the
//                             debounced auto-push refuses to clobber.
export function consumeWsEvent(payload) {
  if (!payload || payload.type !== "document_content_changed") return;
  const md = payload?.data?.metadata;
  if (!md || typeof md !== "object") return;
  const lp = md.local_path;
  const ms = md.cloud_content_updated_at_ms;
  if (typeof lp !== "string" || typeof ms !== "number") return;

  const src = md.source;
  if (SELF_SOURCES.has(src)) {
    // Our own push round-tripped. Move the baseline forward only.
    const seen = _lastSeenCloudMs.get(lp) ?? 0;
    if (ms > seen) _lastSeenCloudMs.set(lp, ms);
    return;
  }

  // Foreign edit. Baseline stays where it was — local file is stale.
  // Mark conflict so the next watcher push for this file is blocked.
  _emitConflict({ relPath: lp, docId: payload.document_id, cloudMs: ms, by: src || "foreign" });
}

export function stopHeartbeat() {
  if (_heartbeatTimer) clearInterval(_heartbeatTimer);
  _heartbeatTimer = null;
  _heartbeatJwt = null;
}
