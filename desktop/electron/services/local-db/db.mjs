/**
 * SQLite connection + sqlite-vec extension load + migrations.
 *
 * Single-machine local mode for SmartNote. Replaces the cloud
 * Postgres for personal-version users.
 *
 * Storage path (per OS):
 *   macOS  : ~/Library/Application Support/SmartNote/local.db
 *   Linux  : ~/.config/SmartNote/local.db
 *   Win    : %APPDATA%/SmartNote/local.db
 *
 * The schema is in ./schema.sql; migrations are idempotent and run
 * on every boot. Future migrations append SQL files numbered 002+.
 */

import { app } from "electron";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let _db = null;
let _ready = false;

export function dbPath() {
  return path.join(app.getPath("userData"), "local.db");
}

export function isReady() { return _ready; }

export function db() {
  if (!_db) throw new Error("local db not initialized — call initLocalDb() first");
  return _db;
}

export async function initLocalDb() {
  if (_db) return _db;
  const file = dbPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });

  _db = new Database(file);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");
  _db.pragma("synchronous = NORMAL");

  // Load sqlite-vec via the package's bundled native lib.
  // Without this, the `vec0` virtual table type is unknown and
  // CREATE VIRTUAL TABLE fails.
  try {
    sqliteVec.load(_db);
  } catch (e) {
    console.error("[local-db] sqlite-vec load failed:", e);
    throw new Error(
      "sqlite-vec extension failed to load. Ensure `sqlite-vec` " +
      "is installed (`npm install sqlite-vec` in desktop/) and that " +
      "the platform's prebuilt binary is present in node_modules.",
    );
  }

  // Apply schema (idempotent — every CREATE uses IF NOT EXISTS).
  const schemaSql = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf-8");
  _db.exec(schemaSql);

  // Best-effort retention sweep: prune pipeline_events older than
  // 30 days at boot. Personal-version users won't accumulate millions
  // of rows, but a long-running install over months would. Cheap to
  // run once per boot.
  try {
    const cutoff = Date.now() - 30 * 86_400_000;
    const r = _db.prepare(`DELETE FROM pipeline_events WHERE at < ?`).run(cutoff);
    if (r.changes) console.log(`[local-db] retention: pruned ${r.changes} pipeline_events`);
  } catch (e) {
    console.warn("[local-db] retention sweep failed:", e?.message || e);
  }

  _ready = true;
  console.log("[local-db] ready @", file);
  return _db;
}

export function closeLocalDb() {
  if (_db) {
    try { _db.close(); } catch {}
    _db = null;
    _ready = false;
  }
}

/** Convenience: parse JSON columns that the schema stores as TEXT. */
export function parseJson(text, fallback = null) {
  if (text == null) return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
}

/** Stringify for JSON-typed columns. */
export function toJson(value) {
  return JSON.stringify(value ?? null);
}
