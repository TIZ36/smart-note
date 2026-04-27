/* Local FTS5 search — offline fallback when cloud is unreachable.
 *
 * Replaces server/app/retrieval.py's 2-path (FTS + substring) baseline.
 * pgvector and the other 4 paths live in the cloud — local stays
 * deliberately minimal so we don't drift back into the "two retrievers"
 * trap. When cloud is online, the renderer skips this entirely.
 *
 * Schema: a single `chunks` virtual FTS5 table indexed on (rel_path,
 * line_no, content). Re-indexing on file change is the responsibility
 * of the sync service — it owns the file watcher.
 */
import Database from "better-sqlite3";
import { app } from "electron";
import path from "node:path";
import { promises as fs } from "node:fs";

let _db = null;

function dbPath() {
  return path.join(app.getPath("userData"), "smartnote", "local-search.db");
}

async function ensureDb() {
  if (_db) return _db;
  const p = dbPath();
  await fs.mkdir(path.dirname(p), { recursive: true });
  _db = new Database(p);
  _db.pragma("journal_mode = WAL");
  _db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(
      rel_path UNINDEXED,
      line_no UNINDEXED,
      content,
      tokenize='porter unicode61'
    );
  `);
  return _db;
}

export async function indexFile(relPath, content) {
  const db = await ensureDb();
  const lines = (content || "").split("\n");
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM chunks WHERE rel_path = ?").run(relPath);
    const ins = db.prepare("INSERT INTO chunks (rel_path, line_no, content) VALUES (?, ?, ?)");
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (l.trim()) ins.run(relPath, i + 1, l);
    }
  });
  tx();
}

export async function removeFile(relPath) {
  const db = await ensureDb();
  db.prepare("DELETE FROM chunks WHERE rel_path = ?").run(relPath);
}

export async function search(query, limit = 20) {
  const db = await ensureDb();
  if (!query || !query.trim()) return [];
  // FTS5 MATCH first (token search). If the user typed something that
  // FTS rejects (special chars), fall back to LIKE substring.
  try {
    const rows = db.prepare(
      "SELECT rel_path, line_no, content, rank FROM chunks " +
      "WHERE chunks MATCH ? ORDER BY rank LIMIT ?"
    ).all(query, limit);
    if (rows.length) return rows.map(r => ({ ...r, score: -r.rank }));
  } catch {
    /* fall through to LIKE */
  }
  const rows = db.prepare(
    "SELECT rel_path, line_no, content FROM chunks " +
    "WHERE content LIKE ? LIMIT ?"
  ).all(`%${query}%`, limit);
  return rows.map(r => ({ ...r, score: 0.5 }));
}

export async function close() {
  if (_db) { _db.close(); _db = null; }
}
