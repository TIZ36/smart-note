/**
 * OpenAI-compatible chat-completions client.
 *
 * Single client, used by every LLM-using stage (ai_enrich,
 * wiki_abstract, note_classify). Reads provider config from the
 * desktop's settings.json (provider_base_url / provider_api_key /
 * provider_chat_model), so the user has one place to swap between
 * Anthropic / OpenAI / DeepSeek / Together / OpenRouter / Ollama.
 *
 * Returns: { content, prompt_tokens, completion_tokens, model }.
 */

import { read as readSettings } from "../settings.mjs";

export class LLMNotConfiguredError extends Error {
  constructor() { super("LLM not configured (set Provider URL + key in Settings)"); }
}

export async function llmChat({
  messages,
  json = false,
  max_tokens = 2000,
  temperature = 0.2,
} = {}) {
  const s = await readSettings();
  const base = (s.provider_base_url || "").replace(/\/+$/, "");
  const key  = s.provider_api_key || "";
  const model = s.provider_chat_model || "";
  if (!base || !key || !model) throw new LLMNotConfiguredError();

  // OpenAI-compat: POST {base}/chat/completions
  const body = {
    model,
    messages,
    max_tokens,
    temperature,
  };
  if (json) {
    // Most providers honor this hint; harmless on those that don't.
    body.response_format = { type: "json_object" };
  }
  const r = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${key}`,
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`LLM ${r.status}: ${txt.slice(0, 300)}`);
  }
  const j = await r.json();
  const content = j?.choices?.[0]?.message?.content || "";
  const usage = j?.usage || {};
  return {
    content,
    prompt_tokens: Number(usage.prompt_tokens || 0),
    completion_tokens: Number(usage.completion_tokens || 0),
    model: j?.model || model,
  };
}

/* ── cost rate table (USD per million tokens). Mirrors cloud
 *    services/llm_cost.py so users get the same number on both
 *    sides. Add new models here as you onboard them.
 */
const RATES = {
  "claude-haiku-4-5":              { in: 0.80, out: 4.00 },
  "claude-haiku-4-5-20251001":     { in: 0.80, out: 4.00 },
  "claude-sonnet-4-6":             { in: 3.00, out: 15.00 },
  "claude-opus-4-7":               { in: 15.00, out: 75.00 },
  "gpt-4o-mini":                   { in: 0.15, out: 0.60 },
  "gpt-4o":                        { in: 2.50, out: 10.00 },
  "deepseek-chat":                 { in: 0.27, out: 1.10 },
};

export function costUsd({ model, prompt_tokens = 0, completion_tokens = 0 } = {}) {
  if (!model) return 0;
  // Try exact match first, then prefix match (handles dated suffixes).
  const exact = RATES[model];
  const fuzzy = exact
    || RATES[Object.keys(RATES).find((k) => model.startsWith(k))]
    || null;
  if (!fuzzy) return 0;
  const usd = (prompt_tokens / 1_000_000) * fuzzy.in
            + (completion_tokens / 1_000_000) * fuzzy.out;
  return Math.round(usd * 1_000_000) / 1_000_000;
}

export function rateLabel(model) {
  if (!model) return null;
  const exact = RATES[model] || RATES[Object.keys(RATES).find((k) => model.startsWith(k))];
  if (!exact) return null;
  return {
    input:  `$${exact.in.toFixed(2)} / MTok`,
    output: `$${exact.out.toFixed(2)} / MTok`,
  };
}

/** Try to extract the FIRST JSON object from arbitrary content.
 *  LLMs sometimes wrap JSON in markdown fences. */
export function tryParseJson(content, fallback = null) {
  if (!content) return fallback;
  // Strip ```json … ``` fences if present
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : content;
  try {
    return JSON.parse(candidate);
  } catch {}
  // Try first {…} block
  const m = candidate.match(/\{[\s\S]*\}/);
  if (m) {
    try { return JSON.parse(m[0]); } catch {}
  }
  return fallback;
}
