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
};

const _debounce = new Map();          // rel_path → setTimeout
const _inflight = new Set();          // rel_path with active fetch

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
  // Upsert as a document by name = rel_path.
  const r = await fetch(`${cloudUrl}/v1/documents`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt}`,
    },
    body: JSON.stringify({ name: relPath, content, kind: "markdown" }),
  });
  if (!r.ok) throw new Error(`push ${relPath}: ${r.status}`);
  return await r.json();
}

function _schedulePush(relPath, absPath) {
  if (_debounce.has(relPath)) clearTimeout(_debounce.get(relPath));
  _state.pending = _debounce.size + 1;
  _debounce.set(relPath, setTimeout(async () => {
    _debounce.delete(relPath);
    if (_inflight.has(relPath)) return;
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
