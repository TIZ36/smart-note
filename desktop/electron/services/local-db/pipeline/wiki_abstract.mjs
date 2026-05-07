/**
 * Stage: wiki_abstract (local mode).
 *
 * Phase B: per-chapter LLM summary + keyword extraction. Mirrors
 * cloud/api/app/contexts/knowledge/wiki_phase_b.py:
 *   1) Split document content into chapters by H1/H2 headings
 *   2) For each chapter, prompt the LLM for { summary, keywords }
 *   3) Persist into wiki_chapters; emit per-chapter progress events
 *      with run_id so the in-app Logs channel can replay the chain
 */

import { randomUUID, createHash } from "node:crypto";
import { db, toJson } from "../db.mjs";
import { emit, finishRun, startRun } from "../events.mjs";
import { llmChat, costUsd, rateLabel, tryParseJson, LLMNotConfiguredError } from "../llm.mjs";

const SYSTEM_PROMPT = `You are a careful technical editor. For each chapter you read, write a 2-3 sentence summary that captures the core ideas, then list 3-6 short keyword phrases. Output JSON only.`;

function buildUserPrompt(title, body) {
  return [
    `Output schema: { "summary": "...", "keywords": ["...", "..."] }`,
    `Chapter title: ${title}`,
    `Body:\n"""\n${body.slice(0, 6000)}\n"""`,
  ].join("\n\n");
}

function splitChapters(text) {
  const lines = text.split("\n");
  const heads = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^#{1,2}\s/.test(lines[i])) heads.push(i);
  }
  if (!heads.length) {
    return [{
      ord: 0,
      title: "(untitled)",
      line_start: 0,
      line_end: lines.length - 1,
      content: text,
    }];
  }
  const out = [];
  for (let i = 0; i < heads.length; i++) {
    const start = heads[i];
    const end = (heads[i + 1] ?? lines.length) - 1;
    const title = lines[start].replace(/^#{1,2}\s+/, "").trim() || "(untitled)";
    out.push({
      ord: i,
      title,
      line_start: start,
      line_end: end,
      content: lines.slice(start, end + 1).join("\n"),
    });
  }
  return out;
}

function sha256Hex(s) {
  return createHash("sha256").update(s).digest("hex");
}

export async function run({ document_id, force = false }) {
  const docRow = db().prepare(
    `SELECT id, content FROM documents WHERE id = ?`,
  ).get(document_id);
  if (!docRow) throw new Error(`document not found: ${document_id}`);

  const chapters = splitChapters(docRow.content || "");
  const run_id = startRun({ kind: "wiki_abstract", document_id });
  const t0 = Date.now();

  // Replace chapters table — preserve summary_sha so we can skip
  // unchanged chapters unless force=true.
  const existing = db().prepare(
    `SELECT id, ord, title, summary, summary_sha FROM wiki_chapters WHERE document_id = ?`,
  ).all(document_id);
  const prevByOrd = new Map(existing.map((r) => [r.ord, r]));

  try {
    let prompt_tokens_total = 0;
    let completion_tokens_total = 0;
    let model_used = null;
    let summarized = 0;
    let skipped = 0;
    let failed = 0;

    // Snapshot the chapter list (delete + reinsert to keep ord stable).
    const replaceTx = db().transaction(() => {
      db().prepare(`DELETE FROM wiki_chapters WHERE document_id = ?`).run(document_id);
      const ins = db().prepare(
        `INSERT INTO wiki_chapters
          (id, document_id, ord, title, line_start, line_end,
           summary, summary_sha, summarized, keywords, entities)
         VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 0, '[]', '[]')`,
      );
      for (const c of chapters) {
        ins.run(randomUUID(), document_id, c.ord, c.title, c.line_start, c.line_end);
      }
    });
    replaceTx();

    emit({
      event: "wiki_abstract_progress",
      document_id, run_id,
      stage: "wiki_abstract", status: "running",
      progress_current: 0, progress_total: chapters.length,
      data: { phase: "started", total: chapters.length, summarized: 0, failed: 0 },
    });

    const updateStmt = db().prepare(
      `UPDATE wiki_chapters
       SET summary = ?, summary_sha = ?, summarized = 1, keywords = ?
       WHERE document_id = ? AND ord = ?`,
    );

    for (let i = 0; i < chapters.length; i++) {
      const c = chapters[i];
      const sha = sha256Hex(c.content);
      const prev = prevByOrd.get(c.ord);
      if (!force && prev && prev.summary_sha === sha && prev.summary) {
        skipped++;
        // Restore previous summary so the table doesn't appear empty.
        updateStmt.run(prev.summary, sha, "[]", document_id, c.ord);
        emit({
          event: "wiki_abstract_progress",
          document_id, run_id,
          stage: "wiki_abstract", status: "running",
          progress_current: i + 1, progress_total: chapters.length,
          data: {
            phase: "chapter_skipped",
            chapter_id: c.ord, chapter_title: c.title,
            total: chapters.length, summarized, skipped, failed,
          },
        });
        continue;
      }
      try {
        const out = await llmChat({
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: buildUserPrompt(c.title, c.content) },
          ],
          json: true,
          max_tokens: 400,
        });
        prompt_tokens_total += out.prompt_tokens;
        completion_tokens_total += out.completion_tokens;
        model_used = out.model;
        const parsed = tryParseJson(out.content) || {};
        const summary = String(parsed.summary || "").trim().slice(0, 1200);
        const keywords = Array.isArray(parsed.keywords)
          ? parsed.keywords.filter((k) => typeof k === "string").slice(0, 12)
          : [];
        updateStmt.run(summary, sha, toJson(keywords), document_id, c.ord);
        summarized++;
        emit({
          event: "wiki_abstract_progress",
          document_id, run_id,
          stage: "wiki_abstract", status: "running",
          progress_current: i + 1, progress_total: chapters.length,
          data: {
            phase: "chapter_done",
            chapter_id: c.ord, chapter_title: c.title,
            total: chapters.length, summarized, skipped, failed,
          },
        });
      } catch (e) {
        if (e instanceof LLMNotConfiguredError) throw e;
        failed++;
        const msg = String(e?.message || e);
        db().prepare(
          `UPDATE wiki_chapters SET last_error = ? WHERE document_id = ? AND ord = ?`,
        ).run(msg, document_id, c.ord);
        emit({
          event: "wiki_abstract_progress",
          document_id, run_id,
          stage: "wiki_abstract", status: "running",
          progress_current: i + 1, progress_total: chapters.length,
          error: msg,
          data: {
            phase: "chapter_failed",
            chapter_id: c.ord, chapter_title: c.title,
            total: chapters.length, summarized, skipped, failed,
          },
        });
      }
    }

    const duration_ms = Date.now() - t0;
    const cost = costUsd({ model: model_used, prompt_tokens: prompt_tokens_total, completion_tokens: completion_tokens_total });
    const final_status = failed === 0 ? "done" : (summarized > 0 ? "partial" : "failed");
    const result_payload = {
      chapters: chapters.length,
      summarized, skipped, failed,
      prompt_tokens: prompt_tokens_total,
      completion_tokens: completion_tokens_total,
      duration_ms,
      executor: "inline",
      model: model_used,
      cost_usd: cost,
      rate: rateLabel(model_used),
    };
    finishRun({
      run_id, status: final_status, result: result_payload,
      error: failed && summarized === 0 ? "all chapters failed" : null,
    });
    emit({
      event: "wiki_abstract_done",
      document_id, run_id,
      stage: "wiki_abstract", status: final_status,
      progress_current: summarized, progress_total: chapters.length,
      data: {
        ...result_payload,
        input_tokens: prompt_tokens_total,
        output_tokens: completion_tokens_total,
      },
    });

    return { run_id, status: final_status, dedup_skipped: false, revision: 0 };
  } catch (e) {
    finishRun({ run_id, status: "failed", error: String(e?.message || e) });
    emit({
      event: "wiki_abstract_done",
      document_id, run_id,
      stage: "wiki_abstract", status: "failed",
      error: String(e?.message || e),
    });
    throw e;
  }
}
