/**
 * Stage: note_classify (local mode).
 *
 * Dict-constrained classifier — LLM picks a SUBSET of workspace_tags
 * applicable to the note's content, with confidence scores. AI never
 * invents new tags; unknown ones returned by the model are dropped.
 *
 * Output → note_tag_suggestions (status='pending'). User accepts/
 * dismisses via the Notes pane Tags tab.
 */

import { db, toJson } from "../db.mjs";
import { emit, finishRun, startRun } from "../events.mjs";
import { llmChat, costUsd, rateLabel, tryParseJson, LLMNotConfiguredError } from "../llm.mjs";

const SYSTEM_PROMPT = `You are a tag classifier. Pick a SUBSET of the provided tags that genuinely apply to the note's content. Each tag chosen must come from the allowed list. For each, give a confidence (0-1) and one short reason (≤ 12 words). If no tag applies, return an empty array. Output JSON only.`;

function buildUserPrompt(content, tags) {
  return [
    `Allowed tags (closed list, choose 0..N): ${JSON.stringify(tags)}.`,
    `Output schema: { "suggestions": [{ "tag": "...", "confidence": 0..1, "reasoning": "..." }] }`,
    `Note content (truncated to 6000 chars):\n"""\n${content.slice(0, 6000)}\n"""`,
  ].join("\n\n");
}

export async function run({ document_id, force = false }) {
  void force;
  const docRow = db().prepare(
    `SELECT id, content FROM documents WHERE id = ?`,
  ).get(document_id);
  if (!docRow) throw new Error(`document not found: ${document_id}`);

  let vocabRows = db().prepare(`SELECT name FROM workspace_tags ORDER BY sort_order`).all();
  if (!vocabRows.length) {
    // Without a dictionary, note_classify is meaningless — return empty.
    const run_id = startRun({ kind: "note_classify", document_id });
    finishRun({ run_id, status: "done", result: { suggested_count: 0, dictionary_size: 0, mode: "user_dict_constrained" } });
    emit({
      event: "note_classify_done",
      document_id, run_id, stage: "note_classify", status: "done",
      progress_current: 0, progress_total: 0,
      data: { suggested_count: 0, dictionary_size: 0, mode: "user_dict_constrained" },
    });
    return { run_id, status: "done", suggested_count: 0 };
  }
  const vocab = vocabRows.map((r) => r.name);

  const run_id = startRun({ kind: "note_classify", document_id });
  const t0 = Date.now();

  try {
    const out = await llmChat({
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildUserPrompt(docRow.content || "", vocab) },
      ],
      json: true,
      max_tokens: 600,
      temperature: 0.1,
    });
    const parsed = tryParseJson(out.content) || {};
    const raw = Array.isArray(parsed.suggestions) ? parsed.suggestions : [];

    // Validate every suggested tag is in vocab; case-insensitive
    // match, drop hallucinations, dedupe by canonical name.
    const vocabLower = new Map(vocab.map((v) => [v.toLowerCase(), v]));
    const seen = new Map();
    for (const s of raw) {
      const tagRaw = typeof s?.tag === "string" ? s.tag.toLowerCase() : null;
      if (!tagRaw) continue;
      const canon = vocabLower.get(tagRaw);
      if (!canon) continue;
      const conf = typeof s.confidence === "number" ? Math.max(0, Math.min(1, s.confidence)) : 0.5;
      const reasoning = String(s.reasoning || "").slice(0, 200);
      const prev = seen.get(canon);
      if (!prev || conf > prev.confidence) {
        seen.set(canon, { tag: canon, confidence: conf, reasoning });
      }
    }
    const suggestions = [...seen.values()].sort((a, b) => b.confidence - a.confidence).slice(0, 12);

    // Persist as pending (replace existing pending for any tag we
    // re-suggested via the unique partial index pattern).
    const now = Date.now();
    const tx = db().transaction((rows) => {
      for (const s of rows) {
        // Delete existing pending for (doc, tag), then insert fresh.
        db().prepare(
          `DELETE FROM note_tag_suggestions
           WHERE document_id = ? AND tag = ? AND status = 'pending'`,
        ).run(document_id, s.tag);
        db().prepare(
          `INSERT INTO note_tag_suggestions
            (document_id, run_id, tag, confidence, reasoning, status, proposed_at)
           VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
        ).run(document_id, run_id, s.tag, s.confidence, s.reasoning, now);
      }
    });
    tx(suggestions);

    const duration_ms = Date.now() - t0;
    const cost = costUsd({ model: out.model, prompt_tokens: out.prompt_tokens, completion_tokens: out.completion_tokens });
    const result_payload = {
      suggested_count: suggestions.length,
      dictionary_size: vocab.length,
      mode: "user_dict_constrained",
      prompt_tokens: out.prompt_tokens,
      completion_tokens: out.completion_tokens,
      duration_ms,
      executor: "inline",
      model: out.model,
      cost_usd: cost,
      rate: rateLabel(out.model),
    };
    finishRun({ run_id, status: "done", result: result_payload });
    emit({
      event: "note_classify_done",
      document_id, run_id,
      stage: "note_classify", status: "done",
      progress_current: suggestions.length,
      progress_total: vocab.length,
      data: {
        ...result_payload,
        input_tokens: out.prompt_tokens,
        output_tokens: out.completion_tokens,
      },
      suggested_count: suggestions.length,
    });

    return { run_id, status: "done", suggested_count: suggestions.length };
  } catch (e) {
    if (e instanceof LLMNotConfiguredError) {
      finishRun({ run_id, status: "failed", error: e.message });
      emit({
        event: "note_classify_done",
        document_id, run_id,
        stage: "note_classify", status: "failed",
        error: e.message,
      });
      throw e;
    }
    finishRun({ run_id, status: "failed", error: String(e?.message || e) });
    emit({
      event: "note_classify_done",
      document_id, run_id,
      stage: "note_classify", status: "failed",
      error: String(e?.message || e),
    });
    throw e;
  }
}
