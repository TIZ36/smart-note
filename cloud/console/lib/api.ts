// Typed fetch layer for the SmartNote Cloud API. Every call resolves
// the base URL and bearer token from localStorage at request time so a
// sign-out invalidates in-flight components on the next call.

import { jwtExpired, readSession, updateJwt } from "./auth";
import type {
  AskResult, Citation, DocItem, DocKind, Note, Run, RunStatus,
} from "./types";

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export type TokenExchange = {
  jwt: string;
  expires_at: number;
  scopes: string[];
  workspace_id: string;
  agent_id: string | null;
};

// `sn_live_…` workspace API keys → short-lived JWT. The JWT is the
// actual bearer the rest of the API expects.
export async function exchangeToken(url: string, apiKey: string): Promise<TokenExchange> {
  const r = await fetch(`${url.replace(/\/+$/, "")}/v1/auth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: apiKey }),
  });
  if (r.status === 401 || r.status === 400) throw new ApiError(r.status, "invalid api key");
  if (!r.ok) throw new ApiError(r.status, `cloud unreachable (${r.status})`);
  return r.json();
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let s = readSession();
  if (!s) throw new ApiError(401, "not signed in");
  // Auto-refresh expired/expiring JWT before the call.
  if (jwtExpired(s)) {
    try {
      const ex = await exchangeToken(s.url, s.apiKey);
      updateJwt(ex.jwt, ex.expires_at);
      s = readSession()!;
    } catch (e) {
      throw new ApiError(401, "session expired — sign in again");
    }
  }
  const r = await fetch(`${s.url}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${s.jwt}`,
      ...(init?.headers || {}),
    },
  });
  // One transparent retry on 401: maybe the JWT was rotated server-side.
  if (r.status === 401) {
    try {
      const ex = await exchangeToken(s.url, s.apiKey);
      updateJwt(ex.jwt, ex.expires_at);
      const retry = await fetch(`${s.url}${path}`, {
        ...init,
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${ex.jwt}`,
          ...(init?.headers || {}),
        },
      });
      if (!retry.ok) throw await asError(retry);
      return retry.json();
    } catch (e) {
      throw e instanceof ApiError ? e : new ApiError(401, "session expired");
    }
  }
  if (!r.ok) throw await asError(r);
  return r.json() as Promise<T>;
}

async function asError(r: Response): Promise<ApiError> {
  let detail = r.statusText;
  try { const j = await r.json(); detail = j.detail || j.error || detail; } catch {}
  return new ApiError(r.status, detail);
}

// ─── Execution log ─────────────────────────────────────────────────
type RawRun = {
  run_id: string;
  document_id: string | null;
  stage: string | null;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  event_count: number;
  status: string;
};
type RawStats = {
  events_total: number; events_24h: number;
  runs_total: number;   runs_24h: number;
  errors_24h: number;   cost_24h_usd: number;
};
type RawRunChain = {
  run_id: string;
  document_id: string | null;
  stage: string | null;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  status: string | null;
  cost_usd: number | null;
  model: string | null;
  events: Array<{
    at: string | null; stage: string | null; event: string | null;
    status: string | null; message: string | null; error: string | null;
    data: Record<string, unknown>;
  }>;
};

// Stage events use a wider vocabulary than the dot. Normalize them to
// the three states the UI cares about.
function normStatus(s: string | null | undefined): RunStatus {
  if (s === "done" || s === "ok" || s === "complete" || s === "completed") return "done";
  if (s === "failed" || s === "error" || s === "partial") return "failed";
  return "running";
}

// Pretty time/duration formatters that match the prototype's look
function fmtRelTime(iso: string | null): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  const diff = Date.now() - t;
  if (diff < 60_000)    return `${Math.max(1, Math.floor(diff / 1000))}s ago`;
  if (diff < 3600_000)  return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
  return new Date(t).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
function fmtClockTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}
function fmtShortTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}
function fmtIsoFull(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString();
}
function fmtDuration(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < 1000)   return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
}
function bucketFor(iso: string | null): Run["bucket"] {
  if (!iso) return "Earlier";
  const t = new Date(iso); const now = new Date();
  const sameDay = t.toDateString() === now.toDateString();
  if (sameDay) return "Today";
  const y = new Date(now); y.setDate(y.getDate() - 1);
  if (t.toDateString() === y.toDateString()) return "Yesterday";
  return "Earlier";
}

export async function listRuns(limit = 50): Promise<Run[]> {
  const r = await call<{ runs: RawRun[]; count: number }>(`/v1/logs/recent_runs?limit=${limit}`);
  return r.runs.map((x) => ({
    id: x.run_id,
    stage: x.stage || "(unknown)",
    status: normStatus(x.status),
    doc: x.document_id || "—",                 // overwritten with file name by the page
    docId: x.document_id,
    startedAt: x.started_at,
    time: fmtShortTime(x.started_at),
    timeFull: fmtIsoFull(x.started_at),
    duration: fmtDuration(x.duration_ms),
    cost: "—",
    bucket: bucketFor(x.started_at),
    log: "",
  }));
}

export type LogStats = {
  runsToday: number;
  failedToday: number;
  avgDurationS: number;
  costTodayUsd: number;
};
export async function fetchStats(): Promise<LogStats> {
  const s = await call<RawStats>(`/v1/logs/stats`);
  return {
    runsToday:    s.runs_24h,
    failedToday:  s.errors_24h,
    avgDurationS: 0,                           // not exposed; show "—" in UI when 0
    costTodayUsd: s.cost_24h_usd,
  };
}

export async function fetchRunDetail(runId: string): Promise<{ run: Run; events: RawRunChain["events"]; cost: number | null; model: string | null }> {
  const chain = await call<RawRunChain>(`/v1/logs/runs/${runId}`);
  const log = chain.events.map((e) => {
    const time = e.at ? fmtClockTime(e.at) : "--:--:--";
    const head = `[${time}] ${e.stage || "?"} ${e.event || ""}`.trim();
    const body = e.message || e.error || "";
    const tag = e.status === "failed" ? "FAILED: " : "";
    return body ? `${head} ${tag}${body}` : head;
  }).join("\n");

  const status = normStatus(chain.status);
  const errEvt = chain.events.find((e) => e.error);
  return {
    run: {
      id: chain.run_id,
      stage: chain.stage || "(unknown)",
      status,
      doc: chain.document_id || "—",
      docId: chain.document_id,
      startedAt: chain.started_at,
      time: fmtClockTime(chain.started_at),     // full clock time in detail
      timeFull: fmtIsoFull(chain.started_at),
      duration: fmtDuration(chain.duration_ms),
      cost: chain.cost_usd != null ? `$${chain.cost_usd.toFixed(4)}` : "—",
      bucket: bucketFor(chain.started_at),
      log,
      error: errEvt?.error || undefined,
    },
    events: chain.events,
    cost: chain.cost_usd,
    model: chain.model,
  };
}

// ─── Documents ─────────────────────────────────────────────────────
type RawDoc = {
  id: string;
  name: string;
  kind: string;
  byte_size: number | null;
  ingested_at: string | null;
  created_at: string | null;
  updated_at?: string | null;
  metadata: Record<string, unknown> | null;
};

function fmtSize(bytes: number | null): string {
  if (!bytes) return "0 B";
  const KB = 1024, MB = KB * 1024;
  if (bytes < KB) return `${bytes} B`;
  if (bytes < MB) return `${(bytes / KB).toFixed(1)} KB`;
  return `${(bytes / MB).toFixed(1)} MB`;
}
function inferKind(d: RawDoc): DocKind {
  const t = (d.metadata?.smartnote_type as string) || "";
  if (t === "wiki_topic") return "wiki";
  if (d.kind === "pdf" || d.name.toLowerCase().endsWith(".pdf")) return "pdf";
  return "document";
}

// Map document_id → name, covering every doc the workspace has (notes
// + non-notes). Used by the execution page to resolve document_id
// UUIDs from /v1/logs/recent_runs into human-readable file names.
export async function listDocumentNames(): Promise<Map<string, string>> {
  const r = await call<{ documents: RawDoc[] }>(`/v1/documents`);
  const m = new Map<string, string>();
  for (const d of r.documents) m.set(d.id, d.name);
  return m;
}

export async function listDocuments(): Promise<DocItem[]> {
  const r = await call<{ documents: RawDoc[] }>(`/v1/documents`);
  return r.documents
    // Exclude notes — they live on the Notes page (smartnote_type=note).
    .filter((d) => (d.metadata?.smartnote_type as string) !== "note")
    .map((d) => ({
      id: d.id,
      name: d.name,
      kind: inferKind(d),
      chunks: 0,                                // not exposed by list endpoint
      size: fmtSize(d.byte_size),
      updated: fmtRelTime(d.updated_at || d.ingested_at || d.created_at),
      status: "done" as RunStatus,
      preview: "",                              // fetched lazily on row click
    }));
}

export async function listNotes(): Promise<Note[]> {
  const r = await call<{ documents: RawDoc[] }>(`/v1/documents?smartnote_type=note`);
  return r.documents.map((d) => {
    const tags = (d.metadata?.user_tags as string[]) || [];
    return {
      id: d.id,
      title: d.name.replace(/\.md$/i, ""),
      updated: fmtRelTime(d.updated_at || d.ingested_at || d.created_at),
      tag: tags.includes("starred") ? "starred" : "",
      snippet: "",                              // fetched with the body
      body: "",
    };
  });
}

export async function fetchDocBody(id: string): Promise<string> {
  const r = await call<{ content: string }>(`/v1/documents/${id}`);
  return r.content || "(empty)";
}

// ─── Retrieve (powers Ask Cloud) ───────────────────────────────────
type RawRetrieve = {
  results: Array<{
    id: string;
    kind: string;
    scope: string;
    content?: string;
    text?: string;
    score?: number;
    document_id?: string | null;
    document_name?: string | null;
    metadata?: Record<string, unknown> | null;
  }>;
  query_embedded: boolean;
};

export async function askCloud(query: string): Promise<AskResult> {
  const t0 = performance.now();
  const r = await call<RawRetrieve>(`/v1/retrieve`, {
    method: "POST",
    body: JSON.stringify({ query, topk: 8, hybrid: true }),
  });
  const ms = Math.round(performance.now() - t0);

  // No LLM synthesis endpoint exists yet — surface the top-ranked
  // snippet as the "answer" and the rest as citations. Honest about
  // what the server returns today.
  const top = r.results[0];
  const answer = top
    ? `<strong>Top match — ${escape(top.document_name || top.kind)}:</strong><br>${escape((top.content || top.text || "").slice(0, 400))}${(top.content || top.text || "").length > 400 ? "…" : ""}`
    : `No results matched. Try different wording, or check that the relevant document has been ingested.`;

  const citations: Citation[] = r.results.map((x, i) => ({
    n: i + 1,
    title: x.document_name || `${x.kind} · ${x.id.slice(0, 8)}`,
    meta: `${x.kind}${x.scope ? " · " + x.scope : ""}`,
    score: typeof x.score === "number" ? x.score.toFixed(2) : "—",
  }));

  return {
    answer,
    citations,
    model: r.query_embedded ? "hybrid (vec+lexical)" : "lexical",
    latencyMs: ms,
    cost: "$0.0000",                            // retrieval is free
  };
}

function escape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
