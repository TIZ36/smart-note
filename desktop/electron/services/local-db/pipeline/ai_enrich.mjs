/**
 * Stage: ai_enrich (local mode).
 *
 * For each chunk, classify against workspace_tags. The dictionary
 * is the closed enum — LLM picks tags strictly from it; unknown
 * tags returned by the model are dropped (safety contract).
 *
 * Each segment row gets the highest-confidence tag + a short
 * summary so the Library Wiki pane's "Tag segments" KN tab can
 * show meaningful per-line annotations.
 *
 * Emits cloud-shaped enrich_done payload with cost/model/tokens
 * landed in `data` so StageDetailModal renders identically to
 * cloud-mode.
 */

import { randomUUID } from "node:crypto";
import { db, toJson } from "../db.mjs";
import { emit, finishRun, startRun } from "../events.mjs";
import { llmChat, costUsd, rateLabel, tryParseJson, LLMNotConfiguredError } from "../llm.mjs";

const SYSTEM_PROMPT = `You are a precise information classifier. For each chunk you read, pick the single most relevant tag from the provided list, and write a one-sentence summary (≤ 25 words). If no tag fits, choose "others". Output JSON only.`;

function buildUserPrompt(chunk_text, tags) {
  return [
    `Allowed tags (closed list): ${JSON.stringify(tags)}.`,
    `Output schema: { "tag": "<one-of-allowed>", "confidence": 0-1, "summary": "..." }`,
    `Chunk:\n"""\n${chunk_text}\n"""`,
  ].join("\n\n");
}

export async function run({ document_id, force = false }) {
  void force;
  const docRow = db().prepare(
    `SELECT id, content FROM documents WHERE id = ?`,
  ).get(document_id);
  if (!docRow) throw new Error(`document not found: ${document_id}`);

  const chunks = db().prepare(
    `SELECT id, content, line_start, line_end FROM chunks WHERE document_id = ? ORDER BY ord`,
  ).all(document_id);
  if (!chunks.length) throw new Error("no chunks — run chunk_embed first");

  // workspace_tags = the closed enum. Add a fallback so v3.6 dev
  // works even before the user authored any tags.
  let vocabRows = db().prepare(`SELECT name FROM workspace_tags ORDER BY sort_order`).all();
  if (!vocabRows.length) {
    vocabRows = ["intro", "context", "details", "decision", "todo", "reference", "others"]
      .map((name) => ({ name }));
  }
  const vocab = vocabRows.map((r) => r.name);

  const run_id = startRun({ kind: "ai_enrich", document_id });
  const t0 = Date.now();

  try {
    const segments = [];
    let prompt_tokens_total = 0;
    let completion_tokens_total = 0;
    let model_used = null;

    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      let parsed = null;
      try {
        const out = await llmChat({
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: buildUserPrompt(c.content, vocab) },
          ],
          json: true,
          max_tokens: 200,
          temperature: 0.2,
        });
        prompt_tokens_total += out.prompt_tokens;
        completion_tokens_total += out.completion_tokens;
        model_used = out.model;
        parsed = tryParseJson(out.content);
      } catch (e) {
        if (e instanceof LLMNotConfiguredError) throw e;
        // Per-chunk LLM error is non-fatal — record as 'others' + log.
        console.warn("[ai_enrich] chunk failed:", e?.message || e);
      }
      const tag = parsed?.tag && vocab.includes(parsed.tag) ? parsed.tag : "others";
      const conf = typeof parsed?.confidence === "number" ? Math.max(0, Math.min(1, parsed.confidence)) : 0.4;
      const summary = String(parsed?.summary || "").slice(0, 240);

      segments.push({
        id: randomUUID(),
        line_start: c.line_start,
        line_end: c.line_end,
        tag, confidence: conf, summary,
      });

      emit({
        event: "enrich_progress",
        document_id, run_id,
        stage: "ai_enrich", status: "running",
        progress_current: i + 1,
        progress_total: chunks.length,
        data: { phase: "classified", chunks_done: i + 1, segments_count: segments.length },
      });
    }

    // Persist segments (replace pattern, mirrors cloud)
    const tx = db().transaction((segs) => {
      db().prepare(`DELETE FROM tag_segments WHERE document_id = ?`).run(document_id);
      const ins = db().prepare(
        `INSERT INTO tag_segments
          (id, document_id, line_start, line_end, tag, confidence, summary, meta)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const s of segs) {
        ins.run(s.id, document_id, s.line_start, s.line_end, s.tag, s.confidence, s.summary, toJson({}));
      }
    });
    tx(segments);

    const duration_ms = Date.now() - t0;
    const cost = costUsd({ model: model_used, prompt_tokens: prompt_tokens_total, completion_tokens: completion_tokens_total });
    const result_payload = {
      segments_count: segments.length,
      prompt_tokens: prompt_tokens_total,
      completion_tokens: completion_tokens_total,
      tokens_total: prompt_tokens_total + completion_tokens_total,
      duration_ms,
      max_concurrency: 1,
      executor: "inline",
      model: model_used,
      cost_usd: cost,
      rate: rateLabel(model_used),
    };
    finishRun({ run_id, status: "done", result: result_payload });
    emit({
      event: "enrich_done",
      document_id, run_id,
      stage: "ai_enrich", status: "done",
      progress_current: segments.length,
      progress_total: segments.length,
      data: {
        ...result_payload,
        input_tokens: prompt_tokens_total,
        output_tokens: completion_tokens_total,
      },
    });

    return { run_id, status: "done", dedup_skipped: false, revision: 0 };
  } catch (e) {
    finishRun({ run_id, status: "failed", error: String(e?.message || e) });
    emit({
      event: "enrich_done",
      document_id, run_id,
      stage: "ai_enrich", status: "failed",
      error: String(e?.message || e),
    });
    throw e;
  }
}
