/**
 * Documents CRUD — local-mode equivalent of the cloud
 * `/v1/documents` family. Returns rows shaped like
 * `cloudApi.CloudDocument` so renderer code (LibraryWikiPane,
 * LibraryNotesPane) doesn't have to special-case modes.
 */

import { randomUUID } from "node:crypto";
import { db, parseJson, toJson } from "./db.mjs";

function rowToDoc(r) {
  if (!r) return null;
  return {
    id: r.id,
    workspace_id: r.workspace_id,
    name: r.name,
    byte_size: r.byte_size,
    metadata: parseJson(r.metadata, {}),
    created_at: new Date(r.created_at).toISOString(),
    updated_at: new Date(r.updated_at).toISOString(),
  };
}

function rowToDocFull(r) {
  const d = rowToDoc(r);
  if (!d) return null;
  return { ...d, content: r.content };
}

export function listDocuments({ smartnote_type } = {}) {
  let rows;
  if (smartnote_type) {
    // Filter by metadata.smartnote_type (= the renderer's "kind").
    // SQLite has json_extract for this.
    rows = db().prepare(
      `SELECT * FROM documents
       WHERE json_extract(metadata, '$.smartnote_type') = ?
       ORDER BY updated_at DESC`,
    ).all(smartnote_type);
  } else {
    rows = db().prepare(`SELECT * FROM documents ORDER BY updated_at DESC`).all();
  }
  return { documents: rows.map(rowToDoc), total: rows.length };
}

export function getDocument(id) {
  const r = db().prepare(`SELECT * FROM documents WHERE id = ?`).get(id);
  if (!r) throw new Error(`document not found: ${id}`);
  return rowToDocFull(r);
}

export function createDocument({ name, content = "", smartnote_type = "doc", metadata = {} } = {}) {
  const id = randomUUID();
  const now = Date.now();
  const meta = { ...metadata, smartnote_type };
  const byte_size = Buffer.byteLength(content, "utf-8");
  db().prepare(
    `INSERT INTO documents
      (id, workspace_id, kind, name, content, byte_size, metadata, created_at, updated_at)
     VALUES (?, 'local', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, smartnote_type, name, content, byte_size, toJson(meta), now, now);
  return getDocument(id);
}

export function patchDocument(id, patch) {
  const existing = db().prepare(`SELECT * FROM documents WHERE id = ?`).get(id);
  if (!existing) throw new Error(`document not found: ${id}`);
  const now = Date.now();
  const sets = [];
  const args = [];
  if (patch.name !== undefined) { sets.push("name = ?"); args.push(patch.name); }
  if (patch.content !== undefined) {
    sets.push("content = ?", "byte_size = ?");
    args.push(patch.content, Buffer.byteLength(patch.content, "utf-8"));
  }
  if (patch.metadata !== undefined) {
    const cur = parseJson(existing.metadata, {});
    sets.push("metadata = ?");
    args.push(toJson({ ...cur, ...patch.metadata }));
  }
  if (patch.kind !== undefined) {
    // patching kind = re-classify the document. Cloud route updates
    // metadata.smartnote_type; mirror that here so both modes line up.
    const cur = parseJson(existing.metadata, {});
    sets.push("metadata = ?", "kind = ?");
    args.push(toJson({ ...cur, smartnote_type: patch.kind }), patch.kind);
  }
  if (!sets.length) return getDocument(id);
  sets.push("updated_at = ?");
  args.push(now, id);
  db().prepare(`UPDATE documents SET ${sets.join(", ")} WHERE id = ?`).run(...args);
  return getDocument(id);
}

export function deleteDocument(id) {
  // FK ON DELETE CASCADE on chunks / tag_segments / wiki_chapters /
  // note_tag_suggestions / processing_runs gives a clean removal.
  db().prepare(`DELETE FROM documents WHERE id = ?`).run(id);
  return { deleted: true, id };
}

/* ──────────── Note save / load — replaces the legacy 8787 server ────
 * The Tauri-era `POST /note/save` POSTed to a local Python service.
 * In local-mode we keep notes in the documents table, keyed by their
 * `rawPath` (the file path the user picked / a slug). Upsert by
 * (kind='note', name=rawPath) so saving the same note twice updates
 * in place rather than duplicating.
 *
 * Return shape mirrors the legacy IngestPack / NoteFileState pair so
 * NotePage's existing useState bindings keep working — fields the
 * legacy server populated (lines_stamped, pack with topics/runs)
 * are zeroed; ingest enrich runs separately via `runStage`.
 */

function _utf8Bytes(s) { return Buffer.byteLength(s || "", "utf-8"); }

export function saveNote({ raw_path, content = "", note = "" } = {}) {
  if (!raw_path) throw new Error("saveNote: raw_path required");
  const now = Date.now();
  const meta = { smartnote_type: "note", note_label: note || "", source_path: raw_path };
  const existing = db().prepare(
    `SELECT id FROM documents
     WHERE kind = 'note' AND name = ? LIMIT 1`,
  ).get(raw_path);
  let id;
  if (existing) {
    id = existing.id;
    db().prepare(
      `UPDATE documents
       SET content = ?, byte_size = ?, metadata = ?, updated_at = ?
       WHERE id = ?`,
    ).run(content, _utf8Bytes(content), toJson(meta), now, id);
  } else {
    id = randomUUID();
    db().prepare(
      `INSERT INTO documents
        (id, workspace_id, kind, name, content, byte_size, metadata, created_at, updated_at)
       VALUES (?, 'local', 'note', ?, ?, ?, ?, ?, ?)`,
    ).run(id, raw_path, content, _utf8Bytes(content), toJson(meta), now, now);
  }
  return {
    pack: {
      id,
      raw_path,
      content,
      topics: [],
      runs: [],
    },
    file_state: {
      exists: true,
      raw_path,
      line_count: (content.match(/\n/g)?.length ?? 0) + 1,
      byte_size: _utf8Bytes(content),
    },
    lines_stamped: 0,  // populated by ai_enrich/wiki_abstract — separate stage
  };
}

export function loadNote(raw_path) {
  if (!raw_path) return { exists: false, content: "", file_state: null, external_pack_created: false, external_pack: null };
  const r = db().prepare(
    `SELECT id, content, byte_size FROM documents
     WHERE kind = 'note' AND name = ? LIMIT 1`,
  ).get(raw_path);
  if (!r) return { exists: false, content: "", file_state: null, external_pack_created: false, external_pack: null };
  const content = r.content || "";
  return {
    exists: true,
    content,
    file_state: {
      exists: true,
      raw_path,
      line_count: (content.match(/\n/g)?.length ?? 0) + 1,
      byte_size: r.byte_size,
    },
    external_pack_created: false,
    external_pack: null,
  };
}

/* ──────────────── /v1/documents/{id}/kn  ──────────────── */
/* Returns the knowledge-state composite: chunk_total / embedded_chunk_count
 * / chunks (preview, capped) / tag_segments / wiki_chapters /
 * processing_runs. Same fields as cloud's DocumentKn. */

export function getDocumentKn(id) {
  const doc = getDocument(id);
  const chunks = db().prepare(
    `SELECT id, ord, content, line_start, line_end, has_embedding, created_at
     FROM chunks WHERE document_id = ? ORDER BY ord LIMIT 200`,
  ).all(id);
  const chunkTotalRow = db().prepare(
    `SELECT COUNT(*) AS n FROM chunks WHERE document_id = ?`,
  ).get(id);
  const embeddedRow = db().prepare(
    `SELECT COUNT(*) AS n FROM chunks WHERE document_id = ? AND has_embedding = 1`,
  ).get(id);
  const tagSegments = db().prepare(
    `SELECT id, line_start, line_end, tag, confidence, summary, meta
     FROM tag_segments WHERE document_id = ? ORDER BY line_start`,
  ).all(id).map((r) => ({ ...r, meta: parseJson(r.meta, {}) }));
  const wikiChapters = db().prepare(
    `SELECT id, ord, title, line_start, line_end, summary, summary_sha,
            summarized, keywords, entities, last_error
     FROM wiki_chapters WHERE document_id = ? ORDER BY ord`,
  ).all(id).map((r) => ({
    ...r,
    summarized: !!r.summarized,
    keywords: parseJson(r.keywords, []),
    entities: parseJson(r.entities, []),
  }));
  const processingRuns = db().prepare(
    `SELECT id, kind, status, executor, error, revision, result, created_at, started_at, finished_at
     FROM processing_runs
     WHERE document_id = ?
     ORDER BY created_at DESC`,
  ).all(id).map((r) => ({
    id: r.id,
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

  return {
    ...doc,
    entity_count: 0,                           // graph stage isn't ported; surface as 0
    chunk_total: chunkTotalRow?.n || 0,
    embedded_chunk_count: embeddedRow?.n || 0,
    tag_segment_total: tagSegments.length,
    chunks: chunks.map((r) => ({ ...r, has_embedding: !!r.has_embedding })),
    tag_segments: tagSegments,
    wiki_chapters: wikiChapters,
    processing_runs: processingRuns,
  };
}
