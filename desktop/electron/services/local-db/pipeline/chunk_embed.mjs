/**
 * Stage: chunk_embed (local mode).
 *
 * Equivalent of cloud's chunk_embed_done event chain. Steps:
 *   1) Re-read document content
 *   2) Run semantic chunking
 *   3) DELETE-then-INSERT chunks (idempotent rerun)
 *   4) Embed via the local `embed` docker service
 *   5) INSERT into chunk_vec virtual table (sqlite-vec)
 *   6) Mark chunks.has_embedding = 1
 *
 * Emits:
 *   - chunk_embed_started        (status=running)
 *   - chunk_embed_progress …     (per batch)
 *   - chunk_embed_done           (status=done) with chunks_count, etc.
 */

import { randomUUID } from "node:crypto";
import { db, toJson } from "../db.mjs";
import { emit, finishRun, startRun } from "../events.mjs";
import { chunk as semanticChunk } from "../chunking.mjs";
import { embedAll } from "../embed.mjs";

export async function run({ document_id, force = false }) {
  void force; // chunk_embed is always idempotent (delete-then-insert)
  const docRow = db().prepare(
    `SELECT id, content FROM documents WHERE id = ?`,
  ).get(document_id);
  if (!docRow) throw new Error(`document not found: ${document_id}`);

  const run_id = startRun({ kind: "chunk_embed", document_id });
  const t0 = Date.now();

  try {
    // 1-2: chunk
    const items = semanticChunk(docRow.content || "");
    emit({
      event: "chunk_embed_progress",
      document_id,
      run_id,
      stage: "chunk_embed",
      status: "running",
      progress_current: 0,
      progress_total: items.length,
      data: { phase: "chunked", chunks_count: items.length },
    });

    // 3: replace chunks for this doc
    const replaceTx = db().transaction((rows) => {
      db().prepare(`DELETE FROM chunk_vec
                    WHERE rowid IN (SELECT rowid FROM chunks WHERE document_id = ?)`)
          .run(document_id);
      db().prepare(`DELETE FROM chunks WHERE document_id = ?`).run(document_id);
      const now = Date.now();
      const ins = db().prepare(
        `INSERT INTO chunks (id, document_id, ord, content, line_start, line_end,
                             has_embedding, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
      );
      const result = [];
      for (const it of rows) {
        const id = randomUUID();
        ins.run(id, document_id, it.ord, it.content, it.line_start, it.line_end, now);
        result.push({ id, ord: it.ord, content: it.content });
      }
      return result;
    });
    const chunks = replaceTx(items);

    // 4-5: embed in batches of 16; emit progress per batch
    const BATCH = 16;
    const all_vecs = [];
    let done = 0;
    for (let i = 0; i < chunks.length; i += BATCH) {
      const slice = chunks.slice(i, i + BATCH);
      const vecs = await embedAll(slice.map((c) => c.content));
      // Insert into chunk_vec keyed by chunks.rowid
      const rowidStmt = db().prepare(`SELECT rowid FROM chunks WHERE id = ?`);
      const insVec = db().prepare(`INSERT INTO chunk_vec(rowid, embedding) VALUES (?, ?)`);
      const markStmt = db().prepare(`UPDATE chunks SET has_embedding = 1 WHERE id = ?`);
      const tx = db().transaction(() => {
        for (let k = 0; k < slice.length; k++) {
          const row = rowidStmt.get(slice[k].id);
          if (!row) continue;
          // sqlite-vec accepts Buffer of float32 LE or JSON-array text.
          // Buffer is faster; vector length must match column dim.
          const buf = Buffer.from(new Float32Array(vecs[k]).buffer);
          insVec.run(row.rowid, buf);
          markStmt.run(slice[k].id);
        }
      });
      tx();
      all_vecs.push(...vecs);
      done += slice.length;
      emit({
        event: "chunk_embed_progress",
        document_id,
        run_id,
        stage: "chunk_embed",
        status: "running",
        progress_current: done,
        progress_total: chunks.length,
        data: {
          phase: "embedding",
          chunks_embedded: done,
          chunks_count: chunks.length,
        },
      });
    }

    const duration_ms = Date.now() - t0;
    const result_payload = {
      chunks_count: chunks.length,
      embedded_count: chunks.length,
      duration_ms,
      executor: "inline",
      model: "bge-m3",
      gpu_seconds: +(duration_ms / 1000 * 0.4).toFixed(2),
    };
    finishRun({ run_id, status: "done", result: result_payload });
    emit({
      event: "chunk_embed_done",
      document_id,
      run_id,
      stage: "chunk_embed",
      status: "done",
      progress_current: chunks.length,
      progress_total: chunks.length,
      data: result_payload,
    });

    return { run_id, status: "done", dedup_skipped: false, revision: 0 };
  } catch (e) {
    finishRun({ run_id, status: "failed", error: String(e?.message || e) });
    emit({
      event: "chunk_embed_done",
      document_id,
      run_id,
      stage: "chunk_embed",
      status: "failed",
      error: String(e?.message || e),
    });
    throw e;
  }
}
