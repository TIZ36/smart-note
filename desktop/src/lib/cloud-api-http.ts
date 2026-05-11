/* Direct-to-cloud HTTP client. Phase 2.5+ — used by Cloud Console.
 *
 * Distinct from `lib/api.ts`, which proxies through the local server.
 * The console talks to the cloud directly so quotas, devices, jobs etc.
 * reflect cloud state without a local relay (the local server still
 * exists for file watching / sync; both clients coexist).
 *
 * JWT cache: we exchange the user's API key for a JWT once and reuse
 * it. On 401 we drop and retry once. Refresh is 60s before expiry.
 */
import { readSettings } from "./electron";

let _jwtCache: { jwt: string; expiresAt: number; key: string } | null = null;

async function getCreds(): Promise<{ baseUrl: string; key: string }> {
  const s = await readSettings();
  const baseUrl = (s.cloud_sync_url || "").replace(/\/+$/, "");
  const key = s.cloud_sync_api_key || "";
  if (!baseUrl || !key) throw new Error("Cloud not configured (Sync tab -> set URL + API key)");
  return { baseUrl, key };
}

async function getJwt(): Promise<{ baseUrl: string; jwt: string }> {
  const { baseUrl, key } = await getCreds();
  const now = Math.floor(Date.now() / 1000);
  if (_jwtCache && _jwtCache.key === key && _jwtCache.expiresAt - 60 > now) {
    return { baseUrl, jwt: _jwtCache.jwt };
  }
  const r = await fetch(`${baseUrl}/v1/auth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: key }),
  });
  if (!r.ok) throw new Error(`auth token: ${r.status}`);
  const d = await r.json() as { jwt: string; expires_at: number };
  _jwtCache = { jwt: d.jwt, expiresAt: d.expires_at, key };
  return { baseUrl, jwt: d.jwt };
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const { baseUrl, jwt } = await getJwt();
  const init: RequestInit = {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt}`,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  };
  let r = await fetch(`${baseUrl}${path}`, init);
  if (r.status === 401) {
    _jwtCache = null;
    const refreshed = await getJwt();
    (init.headers as Record<string, string>).Authorization = `Bearer ${refreshed.jwt}`;
    r = await fetch(`${baseUrl}${path}`, init);
  }
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`${method} ${path} → ${r.status}: ${text.slice(0, 200)}`);
  }
  return r.status === 204 ? undefined as T : await r.json() as T;
}

// ── Types (mirror server pydantic shapes) ──────────────────────────

export type ConsoleOverview = {
  workspace_id: string;
  counts: {
    memories: number; documents: number; devices: number;
    enrich_queued: number; enrich_done: number;
    proposals_pending: number; wiki_nodes: number;
  };
  executors: { mcp_pull: boolean; ws_relay: boolean; cloud_pool: boolean };
  primary_device_online: boolean;
  activity: { kind: string; id: string; summary: string; at: string }[];
};

export type Device = {
  id: string; name: string; platform: string;
  is_primary: boolean; online: boolean;
  last_seen_at: string | null; created_at: string;
};

export type EnrichJob = {
  id: string; document_id: string; status: string;
  executor: string | null; attempts: number;
  result: Record<string, unknown> | null; error: string | null;
  created_at: string; dispatched_at: string | null; finished_at: string | null;
  // Optional convenience fields. The minimal /v1/enrich/jobs response
  // omits them; richer feeds (e.g. UI-side stream) populate when
  // available. Kept optional for forward-compat.
  document_name?: string | null;
  smartnote_type?: string | null;
  progress?: {
    tokens?: { total?: number; in?: number; out?: number };
    classify?: { total: number; done: number };
    phase?: string;
  } | null;
};

// ── Documents ─────────────────────────────────────────────────────

export type CloudDocument = {
  id: string;
  workspace_id: string;
  name: string;
  kind: string;
  byte_size: number;
  ingested_at: string | null;
  created_at: string;
  updated_at: string | null;
  metadata: Record<string, unknown> | null;
};

export const listDocuments = (params?: { since?: string; smartnote_type?: string }) => {
  const q = new URLSearchParams();
  if (params?.since) q.set("since", params.since);
  if (params?.smartnote_type) q.set("smartnote_type", params.smartnote_type);
  const qs = q.toString();
  return call<{ documents: CloudDocument[] }>("GET", `/v1/documents${qs ? "?" + qs : ""}`);
};

export type CloudDocumentFull = CloudDocument & { content: string };

export const getDocument = (id: string) =>
  call<CloudDocumentFull>("GET", `/v1/documents/${id}`);

export const deleteDocument = (id: string) =>
  call<{ deleted: boolean; id: string }>("DELETE", `/v1/documents/${id}`);

export type DocumentKnChunk = {
  id: string;
  dimension: string;
  line_start: number;
  line_end: number;
  text: string;
  keywords: string[];
  source_ref: string | null;
};
export type DocumentKnTagSegment = {
  id: string;
  line_start: number;
  line_end: number;
  tag: string;
  confidence: number;
  summary: string;
  meta: Record<string, unknown>;
};
export type DocumentKnChapter = {
  id: string;
  ord: number;
  level: number;
  anchor: string;
  title: string;
  line_start: number;
  line_end: number;
  summary: string;
  summary_sha?: string | null;
  keywords: string[];
  summarized: boolean;
  /** Latest wiki_phase_b failure reason for this chapter, e.g.
   * "llm_call: TimeoutError: ..." or "llm_response_empty_or_invalid_json".
   * Cleared to null on the next successful run. */
  last_error: string | null;
  updated_at: string | null;
};
export type DocumentKn = {
  document_id: string;
  kind: string;
  /** G-badge truth: number of distinct workspace entities attributed to
   * this doc's tags/chapters via `tag_entities`. Workspace-scoped, so
   * this is approximate per-doc — see /kn endpoint comment. 0 ⇒ no
   * graph rows landed for this doc; UI should render G as pending. */
  entity_count: number;
  /** Total chunk rows for this doc (regardless of embedding state). */
  chunk_total: number;
  /** Chunks whose vector column is non-null. E-badge truth — a chunk
   * row can exist without an embedding if the embed pod was down
   * mid-ingest, so embedded_chunk_count < chunk_total signals a
   * partial run that the user should re-trigger. */
  embedded_chunk_count: number;
  tag_segment_total?: number;
  chunks: DocumentKnChunk[];
  tag_segments: DocumentKnTagSegment[];
  wiki_chapters: DocumentKnChapter[];
  /** Canonical processing-run ledger (migration 021). Sole UI
   * source of run state as of commit 4def060. enrich_jobs was
   * removed from the response; writers stay server-side for
   * executor (mcp_pull / ws_relay) compatibility. */
  processing_runs: DocumentKnProcessingRun[];
};

export type DocumentKnProcessingRun = {
  id: string;
  /** chunk_embed | ai_enrich | wiki_abstract */
  kind: string;
  /** queued | running | done | failed | partial | skipped_dedup | skipped_quota */
  status: string;
  executor: string | null;
  error: string | null;
  revision: number;
  attempts?: number;
  created_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  result: Record<string, unknown> | null;
};
export const getDocumentKn = (id: string) =>
  call<DocumentKn>("GET", `/v1/documents/${id}/kn`);

export const patchDocument = (
  id: string,
  patch: { name?: string; kind?: string; metadata?: Record<string, unknown> },
) => call<CloudDocument>("PATCH", `/v1/documents/${id}`, patch);

// Wiki abstract artifacts. KP triggers buildWikiAbstract so Cloud owns
// summarization and writes wiki_chapters.
export type ProcessingRunResult = {
  run_id: string;
  status: string;
  dedup_skipped?: boolean;
  revision?: number;
};
export const buildWikiAbstract = (id: string, force = true) =>
  call<ProcessingRunResult>("POST", `/v1/processing/${id}/run`, {
    kind: "wiki_abstract", force,
  });
export const runDocumentEnrich = (id: string, force = true) =>
  call<ProcessingRunResult>("POST", `/v1/processing/${id}/run`, {
    kind: "ai_enrich", force,
  });
export const runDocumentChunkEmbed = (id: string, force = true) =>
  call<ProcessingRunResult>("POST", `/v1/processing/${id}/run`, {
    kind: "chunk_embed", force,
  });
// Back-compat alias — same call. Older callers say "smartsheet".
export const buildWikiSmartsheet = buildWikiAbstract;

export type RecentRun = {
  id: string;
  document_id: string;
  document_name: string | null;
  kind: string;
  status: string;
  executor: string | null;
  error: string | null;
  revision: number;
  created_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  result?: Record<string, unknown> | null;
};
export const listRecentRuns = (limit = 50) =>
  call<RecentRun[]>("GET", `/v1/processing/recent?limit=${encodeURIComponent(limit)}`);

export const createDocument = (req: {
  name: string;
  content: string;
  kind?: string;
  metadata?: Record<string, unknown>;
}) => call<CloudDocument>("POST", "/v1/documents", req);

// ── Endpoints ──────────────────────────────────────────────────────

export const fetchOverview = () => call<ConsoleOverview>("GET", "/v1/console/overview");

export const listDevices = () => call<Device[]>("GET", "/v1/devices");
export const pairDevice = () =>
  call<{ pairing_code: string; expires_at: string; device_id: string }>("POST", "/v1/devices/pair", {});
export const promoteDevice = (id: string) => call<Device>("POST", `/v1/devices/${id}/promote`, {});
export const unpairDevice = (id: string) => call<{ deleted: number }>("DELETE", `/v1/devices/${id}`);

// claimDevice: NEW device, has no API key yet — sends the 6-digit code
// from an existing device and gets back a freshly-minted key. Bypasses
// the JWT-cached `call()` helper because there's no key to exchange.
// The base URL must be supplied explicitly (we can't read it from
// settings yet — settings only has a key/url pair the user is in the
// process of *establishing*).
export type ClaimResponse = {
  api_key: string;        // sn_live_<prefix>_<secret>, save once
  workspace_id: string;
  device: Device;
};

export async function claimDevice(
  baseUrl: string,
  pairingCode: string,
  name: string,
  platform: string,
): Promise<ClaimResponse> {
  const url = `${baseUrl.replace(/\/+$/, "")}/v1/devices/claim`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pairing_code: pairingCode, name, platform }),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`claim failed (${r.status}): ${text.slice(0, 200) || "unknown"}`);
  }
  // Successful claim invalidates any prior JWT cache (we're swapping
  // identities). Reset so the next call re-exchanges with the new key.
  _jwtCache = null;
  return r.json() as Promise<ClaimResponse>;
}

export const listEnrichJobs = (status?: string) =>
  call<EnrichJob[]>("GET", `/v1/enrich/jobs${status ? `?status_filter=${status}` : ""}`);
export const runEnrich = (documentId: string) =>
  runDocumentEnrich(documentId, true);
export const deleteEnrichJob = (id: string) =>
  call<{ ok: boolean; deleted: number }>("DELETE", `/v1/enrich/jobs/${id}`);
export const bulkDeleteEnrichJobs = (status?: string) =>
  call<{ ok: boolean; deleted: number }>(
    "DELETE",
    status ? `/v1/enrich/jobs?status_filter=${status}` : "/v1/enrich/jobs",
  );

// ── Cloud-side ingest + chunk search (Stage B) ──────────────────────
//
// Replaces the local Python ingest pipeline. One device runs ingest,
// every device reads the same chunks. The desktop's Search panel /
// Wiki Sources / Special Knowledge prefer these endpoints when cloud
// is configured; local server endpoints stay as offline fallback.

export type IngestRunResult = {
  ingest_run_id: string;
  chunk_count: number;
  dimension: string;
  status: string;
};

export type BulkIngestResult = {
  total: number;
  ingested: number;
  chunks: number;
  failures: { document_id: string; error: string }[];
  enriched: number;
  enrich_failed: number;
  enrich_skipped_no_provider: boolean;
};

export type ChunkSource = {
  document_id: string;
  document_name: string;
  dimension: string;
  chunk_count: number;
  last_ingested_at: string | null;
};

export type ChunkTopic = {
  dimension: string;
  chunk_count: number;
  document_count: number;
};

export type ChunkSearchHit = {
  id: string;
  document_id: string;
  document_name: string;
  dimension: string;
  text: string;
  keywords: string[];
  line_start: number;
  line_end: number;
  source_ref: string;
  score: number;
  path_scores: Record<string, number>;
};

export const ingestDocument = (documentId: string) =>
  call<IngestRunResult>("POST", "/v1/ingest/document", { document_id: documentId });

export const bulkIngest = (opts: {
  document_ids?: string[];
  smartnote_type?: string;
  topic_prefix?: string;
    /** When true, also fires note LLM tag classification via cloud_pool
     *  (workspace's stored provider). Wiki topics use wiki_abstract,
     *  not line-range ai_enrich. Default true. */
  enrich_with_ai?: boolean;
}) =>
  call<BulkIngestResult>("POST", "/v1/ingest/bulk", {
    enrich_with_ai: true,
    ...opts,
  });

export const listIngestSources = () =>
  call<ChunkSource[]>("GET", "/v1/ingest/sources");

export const listIngestTopics = () =>
  call<ChunkTopic[]>("GET", "/v1/ingest/topics");

export const searchChunks = (
  query: string,
  opts: { topk?: number; dimension?: string } = {},
) =>
  call<{ results: ChunkSearchHit[]; query_embedded: boolean }>(
    "POST", "/v1/chunks/search",
    { query, topk: opts.topk ?? 20, dimension: opts.dimension },
  );

// ── Knowledge graph ─────────────────────────────────────────────────
//
// Cloud entities + entity_links are populated by /v1/enrich/run
// (services/kb/entity_graph.py upserts during _write_segments_done).
// Multi-device: device A enriches once, every device renders the
// same graph.

export type CloudGraphNode = {
  id: string; name: string; type: string; mentions: number;
};
export type CloudGraphEdge = {
  source: string; target: string;
  source_name: string; target_name: string;
  relation: string; weight: number;
};
export type CloudGraphResponse = {
  nodes: CloudGraphNode[];
  edges: CloudGraphEdge[];
  tag_entities: Record<string, { name: string; count: number; mention_count: number }[]>;
  stats: {
    total_chunks: number;
    total_entities: number;
    total_memories: number;
    total_feedback: number;
    tags: Record<string, { segments: number; lines: number }>;
  };
};

export const fetchGraph = (topN = 200) =>
  call<CloudGraphResponse>("GET", `/v1/graph?top_n=${topN}`);

export const fetchWikiGraph = (topN = 200) =>
  call<CloudGraphResponse>("GET", `/v1/graph/wiki?top_n=${topN}`);

// ── Search history (cross-device "Recent searches") ───────────────

export type CloudSearchHistoryItem = {
  id: string;
  query_text: string;
  result_count: number;
  tag_filter: string | null;
  created_at: string;
};

export const fetchSearchHistory = (limit = 20) =>
  call<CloudSearchHistoryItem[]>("GET", `/v1/search/history?limit=${limit}`);

export const clearSearchHistory = () =>
  call<{ ok: boolean; deleted: number }>("DELETE", "/v1/search/history");

// ── Workspace tag config ──────────────────────────────────────────

export type CloudTag = {
  id: string;
  name: string;
  description: string;
  color: string;
  sort_order: number;
};

export const fetchTags = () => call<CloudTag[]>("GET", "/v1/tags");

export const upsertTag = (tag: { name: string; description?: string; color?: string; sort_order?: number }) =>
  call<CloudTag>("POST", "/v1/tags", tag);

export const deleteTag = (name: string) =>
  call<{ ok: boolean; deleted: number }>("DELETE", `/v1/tags/${encodeURIComponent(name)}`);

export const reorderTags = (order: string[]) =>
  call<{ ok: boolean; reordered: number }>("POST", "/v1/tags/reorder", { order });

// ── Enrich provider config ───────────────────────────────────────

export type EnrichProviderConfig = {
  base_url: string;
  model: string;
  timeout_sec: number;
  max_tokens: number;
  max_concurrency: number;
  has_api_key: boolean;
  auto_enrich_on_ingest: boolean;
};

export type EnrichProviderUpdate = {
  api_key?: string | null;
  base_url?: string;
  model?: string;
  timeout_sec?: number;
  max_tokens?: number;
  max_concurrency?: number;
  auto_enrich_on_ingest?: boolean;
};

export const fetchEnrichProvider = () =>
  call<EnrichProviderConfig>("GET", "/v1/enrich/provider");

export const saveEnrichProvider = (cfg: EnrichProviderUpdate) =>
  call<EnrichProviderConfig>("PUT", "/v1/enrich/provider", cfg);

export const deleteEnrichProvider = () =>
  call<{ ok: boolean; archived: number }>("DELETE", "/v1/enrich/provider");


// ── Proposals (agent-submitted draft memories awaiting user review) ───
//
// Backed by /v1/memories/proposals on the cloud (router/proposals.py).
// Surfaced in Insights as the primary daily-use action queue. Each row
// is a draft memory an agent (Claude Code / Cursor / etc.) thought was
// worth remembering but flagged low-confidence. User accepts → it
// becomes a real memory; rejects → archived (kept for lineage).

export type Proposal = {
  id: string;
  workspace_id: string;
  author_agent: string;
  kind: string;
  scope: string;
  content: string;
  tags: string[];
  confidence: number;
  proposal_reason: string | null;
  created_at: string;
};

export type ProposalsList = { proposals: Proposal[]; total: number };

export const listProposals = (
  limitOrOpts: number | { limit?: number; status?: "pending" | "rejected" | "all"; kind?: string } = 20,
) => {
  const opts = typeof limitOrOpts === "number"
    ? { limit: limitOrOpts }
    : limitOrOpts;
  const p = new URLSearchParams();
  p.set("limit", String(opts.limit ?? 20));
  if (opts.status) p.set("status", opts.status);
  if (opts.kind)   p.set("kind",   opts.kind);
  return call<ProposalsList>("GET", `/v1/memories/proposals?${p.toString()}`);
};

export const acceptProposal = (id: string) =>
  call<{ ok: boolean; id: string }>(
    "POST", `/v1/memories/proposals/${id}/accept`, {},
  );

export const rejectProposal = (id: string, reason?: string) =>
  call<{ ok: boolean; id: string }>(
    "POST", `/v1/memories/proposals/${id}/reject`,
    reason ? { reason } : {},
  );

export const batchAcceptProposals = (ids: string[]) =>
  call<{ ok: boolean; accepted: number; requested: number }>(
    "POST", "/v1/memories/proposals/batch-accept", { ids },
  );

/* Accepted memories (the real, committed ones — distinct from
 * Proposals). Backs the Memories tab's Accepted bucket: heatmap
 * + timeline, both feed off of created_at. */
export type Memory = {
  id: string;
  workspace_id: string;
  author_agent: string | null;
  kind: string;
  scope: string;
  content: string;
  tags: string[];
  confidence: number;
  pinned: boolean;
  supersedes: string | null;
  created_at: string;
  updated_at: string;
};

export type MemoriesList = { memories: Memory[] };

export const listMemories = (
  opts: { kind?: string; scope?: string; limit?: number; offset?: number } = {},
) => {
  const p = new URLSearchParams();
  if (opts.kind)   p.set("kind", opts.kind);
  if (opts.scope)  p.set("scope", opts.scope);
  if (opts.limit)  p.set("limit", String(opts.limit));
  if (opts.offset) p.set("offset", String(opts.offset));
  const qs = p.toString();
  return call<MemoriesList>("GET", `/v1/memories${qs ? "?" + qs : ""}`);
};

/* Note tag classification — dict-constrained AI classifier.
 * The LLM proposes (subset of workspace_tags); user accepts or
 * dismisses. AI never directly mutates document.metadata.user_tags. */
export type NoteSuggestion = {
  tag: string;
  confidence: number;
  reasoning: string | null;
  status: string;
  proposed_at: string;
  reviewed_at: string | null;
};
export type NoteSuggestionsList = { suggestions: NoteSuggestion[] };

export const classifyNote = (documentId: string) =>
  call<{ run_id: string; status: string; suggested_count: number }>(
    "POST", `/v1/notes/${documentId}/classify`, {},
  );

export const listNoteSuggestions = (documentId: string) =>
  call<NoteSuggestionsList>("GET", `/v1/notes/${documentId}/suggestions`);

export const acceptNoteSuggestion = (documentId: string, tag: string) =>
  call<{ tag: string; user_tags: string[] }>(
    "POST", `/v1/notes/${documentId}/suggestions/${encodeURIComponent(tag)}/accept`, {},
  );

export const dismissNoteSuggestion = (documentId: string, tag: string) =>
  call<{ tag: string; dismissed: boolean }>(
    "POST", `/v1/notes/${documentId}/suggestions/${encodeURIComponent(tag)}/dismiss`, {},
  );

export const addNoteUserTag = (documentId: string, tag: string) =>
  call<{ tag: string; user_tags: string[] }>(
    "POST", `/v1/notes/${documentId}/user_tags`, { tag },
  );

// Returns whether cloud is configured AT ALL — Insights uses this to
// decide whether to render the proposals card or hide it silently.
export async function isCloudConfigured(): Promise<boolean> {
  try {
    const s = await readSettings();
    return Boolean(s.cloud_sync_url && s.cloud_sync_api_key);
  } catch {
    return false;
  }
}
