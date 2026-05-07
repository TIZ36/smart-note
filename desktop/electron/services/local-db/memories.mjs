/**
 * Memories + proposals + note tag suggestions — local-mode CRUD.
 * Mirrors cloud's /v1/memories/* + /v1/notes/*/suggestions surface.
 */

import { randomUUID } from "node:crypto";
import { db, parseJson, toJson } from "./db.mjs";

function rowToMemory(r) {
  if (!r) return null;
  return {
    id: r.id,
    workspace_id: "local",
    author_agent: r.author_agent,
    kind: r.kind,
    scope: r.scope,
    content: r.content,
    structured: parseJson(r.structured, {}),
    tags: parseJson(r.tags, []),
    source_refs: parseJson(r.source_refs, []),
    confidence: r.confidence,
    pinned: !!r.pinned,
    supersedes: r.supersedes,
    proposal_reason: r.proposal_reason,
    created_at: new Date(r.created_at).toISOString(),
    updated_at: new Date(r.updated_at).toISOString(),
  };
}

/* ── proposals (status='draft' or 'archived') ── */

export function listProposals({ limit = 20, status = "pending", kind = null } = {}) {
  // status is the API surface name; map to DB status:
  //   pending → 'draft'
  //   rejected → 'archived'
  //   all → both
  const dbStatuses = status === "pending" ? ["draft"]
                   : status === "rejected" ? ["archived"]
                   : ["draft", "archived"];
  const placeholders = dbStatuses.map(() => "?").join(", ");
  const args = [...dbStatuses];
  let sql = `SELECT * FROM memories WHERE status IN (${placeholders})`;
  if (kind) { sql += ` AND kind = ?`; args.push(kind); }
  sql += ` ORDER BY created_at DESC LIMIT ?`;
  args.push(limit);
  const rows = db().prepare(sql).all(...args);
  const total = db().prepare(
    `SELECT COUNT(*) AS n FROM memories WHERE status IN (${placeholders})`
    + (kind ? " AND kind = ?" : ""),
  ).get(...dbStatuses, ...(kind ? [kind] : []))?.n || 0;
  return { proposals: rows.map(rowToMemory), total };
}

export function listMemories({ kind = null, scope = null, limit = 50, offset = 0 } = {}) {
  let sql = `SELECT * FROM memories WHERE status = 'active'`;
  const args = [];
  if (kind) { sql += ` AND kind = ?`; args.push(kind); }
  if (scope) { sql += ` AND scope = ?`; args.push(scope); }
  sql += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;
  args.push(limit, offset);
  const rows = db().prepare(sql).all(...args);
  return { memories: rows.map(rowToMemory) };
}

export function acceptProposal(id) {
  const now = Date.now();
  // Simple semantic: flip status to 'active'. Cloud's accept also
  // does optional content edits + supersession; for the personal
  // version that's not on the immediate critical path.
  const r = db().prepare(
    `UPDATE memories SET status = 'active', reviewed_at = ?, updated_at = ?
     WHERE id = ? AND status IN ('draft', 'archived')`,
  ).run(now, now, id);
  if (r.changes === 0) throw new Error("proposal not found or not in draft/archived status");
  return { ok: true, id };
}

export function rejectProposal(id, reason = null) {
  const now = Date.now();
  const reasonTail = reason ? `\n[rejected: ${reason}]` : "\n[rejected]";
  const r = db().prepare(
    `UPDATE memories
     SET status = 'archived',
         reviewed_at = ?, updated_at = ?,
         proposal_reason = COALESCE(proposal_reason, '') || ?
     WHERE id = ? AND status = 'draft'`,
  ).run(now, now, reasonTail, id);
  if (r.changes === 0) throw new Error("proposal not found or not draft");
  return { ok: true, id, status: "archived" };
}

export function batchAcceptProposals(ids = []) {
  if (!Array.isArray(ids) || !ids.length) return { ok: true, accepted: 0, requested: 0 };
  const now = Date.now();
  const tx = db().transaction((list) => {
    let n = 0;
    const stmt = db().prepare(
      `UPDATE memories SET status = 'active', reviewed_at = ?, updated_at = ?
       WHERE id = ? AND status = 'draft'`,
    );
    for (const id of list) n += stmt.run(now, now, id).changes;
    return n;
  });
  const accepted = tx(ids);
  return { ok: true, accepted, requested: ids.length };
}

/* ── note tag suggestions ── */

export function listNoteSuggestions(document_id) {
  const rows = db().prepare(
    `SELECT tag, confidence, reasoning, status, proposed_at, reviewed_at
     FROM note_tag_suggestions
     WHERE document_id = ? AND status = 'pending'
     ORDER BY confidence DESC`,
  ).all(document_id);
  return {
    suggestions: rows.map((r) => ({
      tag: r.tag,
      confidence: r.confidence,
      reasoning: r.reasoning,
      status: r.status,
      proposed_at: new Date(r.proposed_at).toISOString(),
      reviewed_at: r.reviewed_at ? new Date(r.reviewed_at).toISOString() : null,
    })),
  };
}

export function acceptNoteSuggestion(document_id, tag) {
  const now = Date.now();
  const tx = db().transaction(() => {
    // 1. Append to documents.metadata.user_tags[]
    const docRow = db().prepare(
      `SELECT metadata FROM documents WHERE id = ?`,
    ).get(document_id);
    if (!docRow) throw new Error("document not found");
    const meta = parseJson(docRow.metadata, {}) || {};
    const cur = Array.isArray(meta.user_tags) ? [...meta.user_tags] : [];
    if (!cur.includes(tag)) cur.push(tag);
    meta.user_tags = cur;
    db().prepare(
      `UPDATE documents SET metadata = ?, updated_at = ? WHERE id = ?`,
    ).run(toJson(meta), now, document_id);
    // 2. Mark suggestion accepted
    db().prepare(
      `UPDATE note_tag_suggestions
       SET status = 'accepted', reviewed_at = ?
       WHERE document_id = ? AND tag = ? AND status = 'pending'`,
    ).run(now, document_id, tag);
    return cur;
  });
  const user_tags = tx();
  return { tag, user_tags };
}

export function dismissNoteSuggestion(document_id, tag) {
  const now = Date.now();
  db().prepare(
    `UPDATE note_tag_suggestions
     SET status = 'dismissed', reviewed_at = ?
     WHERE document_id = ? AND tag = ? AND status = 'pending'`,
  ).run(now, document_id, tag);
  return { tag, dismissed: true };
}

export function addNoteUserTag(document_id, tag) {
  // Same effect as acceptNoteSuggestion's first half — bypasses
  // the suggestion table when the user types a tag manually.
  return acceptNoteSuggestion(document_id, tag);
}

/* ── helpers used by the propose path (not yet wired but here so
 *    the agent-side or background flows can populate proposals) ── */

export function createProposal({ kind, content, scope = "global", tags = [],
                                 confidence = 0.7, proposal_reason = null,
                                 author_agent = null, structured = {} } = {}) {
  const id = randomUUID();
  const now = Date.now();
  db().prepare(
    `INSERT INTO memories
      (id, kind, scope, content, structured, tags, source_refs, confidence,
       pinned, status, author_agent, proposal_reason, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, '[]', ?, 0, 'draft', ?, ?, ?, ?)`,
  ).run(
    id, kind, scope, content,
    toJson(structured), toJson(tags), confidence,
    author_agent, proposal_reason, now, now,
  );
  return { id };
}
