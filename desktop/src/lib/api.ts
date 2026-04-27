import type {
  SearchResponse,
  ChatResponse,
  FeedbackResponse,
  GraphData,
  RerankResponse,
  SourcePreviewData,
} from "./types";

const BASE = "http://127.0.0.1:8787";

// Stage 1: Recall
//
// Prefers the cloud's /v1/chunks/search endpoint when the workspace
// is configured (Stage B day 2 — multi-device search). Falls back to
// the local /search endpoint otherwise. The cloud and local
// responses share enough shape (results[].text/score/dimension/
// path_scores) that downstream components don't need to branch.
export async function search(
  query: string,
  topk = 20,
  tagFilter?: string | null,
  includeWiki?: string[]
): Promise<SearchResponse> {
  // Cloud path: only when configured AND tagFilter (single wiki dim
  // OR null) is compatible. Multi-wiki @-mentions stay on local since
  // /v1/chunks/search takes a single dimension. We can extend later.
  try {
    const cloudApi = await import("./cloud-api");
    if (await cloudApi.isCloudConfigured() && (!includeWiki || includeWiki.length <= 1)) {
      const dimension = tagFilter && tagFilter.startsWith("wiki:")
        ? tagFilter
        : (includeWiki && includeWiki.length === 1 ? `wiki:${includeWiki[0]}` : undefined);
      const t0 = performance.now();
      const r = await cloudApi.searchChunks(query, { topk, dimension });
      const ms = Math.round(performance.now() - t0);
      // Cloud chunk ids are UUID strings. The `typeof r.id === "number"`
      // filter downstream (used to feed the local rerank endpoint) will
      // skip them — that's intentional; cloud's /chunks/search already
      // applies 6-path scoring, no need to re-rerank locally.
      const results = r.results.map((h): import("./types").SearchResult => ({
        id: h.id,
        text: h.text,
        source_ref: h.source_ref || `cloud:${h.document_id}#${h.line_start}-${h.line_end}`,
        dimension: h.dimension,
        score: h.score,
        path_scores: {
          fts: h.path_scores.fts || 0,
          sub: h.path_scores.sub || 0,
          ngram: h.path_scores.ngram || 0,
          vec: h.path_scores.vec || 0,
          kw: h.path_scores.kw || 0,
          tag_meta: h.path_scores.tag_meta || 0,
        },
        is_wiki: h.dimension.startsWith("wiki:"),
        segment_topic: h.dimension.startsWith("wiki:") ? h.dimension.slice(5) : undefined,
      }));
      return {
        results,
        latency_ms: ms,
        total_recall: results.length,
        is_adaptive: false,
        wiki_topics_found: {},
      };
    }
  } catch (e) {
    console.warn("cloud search failed, falling back to local:", e);
  }
  const body: Record<string, unknown> = { query, topk };
  if (tagFilter) body.tag_filter = tagFilter;
  if (includeWiki && includeWiki.length > 0) body.include_wiki = includeWiki;
  const res = await fetch(`${BASE}/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

export async function fetchTagStats(): Promise<{ tags: { name: string; segments: number; lines: number; coverage_pct: number }[]; daily_growth: { day: string; tag: string; count: number }[] }> {
  const res = await fetch(`${BASE}/tags/stats`);
  return res.json();
}

// Search history
export type SearchHistoryItem = { id: number; query: string; result_count: number; tag_filter: string | null; created_at: string };

export async function fetchSearchHistory(): Promise<{ history: SearchHistoryItem[] }> {
  const res = await fetch(`${BASE}/search/history`);
  return res.json();
}

// Stage 2: Rerank
export async function rerank(
  query: string,
  resultIds: number[],
  useLlm = false,
  topk = 8
): Promise<RerankResponse> {
  const res = await fetch(`${BASE}/rerank`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, result_ids: resultIds, use_llm: useLlm, topk }),
  });
  return res.json();
}

// Stage 3: AI Answer
export type ChatHistoryItem = { role: "user" | "assistant"; content: string };

export async function chat(
  query: string,
  evidenceIds: number[] = [],
  history: ChatHistoryItem[] = [],
  sourceFiles: string[] = [],
): Promise<ChatResponse> {
  const body: Record<string, unknown> = { query, evidence_ids: evidenceIds, history };
  if (sourceFiles.length > 0) body.source_files = sourceFiles;
  const res = await fetch(`${BASE}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

// Stage 3b: Streaming AI Answer — SSE variant of /chat.
// Callbacks fire on delta/done/error; returns a disposer to cancel mid-stream.
export type ChatStreamCallbacks = {
  onDelta: (delta: string) => void;
  onDone: (info: { answer_id: number; latency_ms: number }) => void;
  onError: (err: string) => void;
  onEvidence?: (ids: number[]) => void;
  onSourceFiles?: (files: string[]) => void;
};

export function chatStream(
  query: string,
  evidenceIds: number[] = [],
  history: ChatHistoryItem[] = [],
  sourceFiles: string[] = [],
  cb: ChatStreamCallbacks,
): () => void {
  const controller = new AbortController();
  const body: Record<string, unknown> = { query, evidence_ids: evidenceIds, history };
  if (sourceFiles.length > 0) body.source_files = sourceFiles;

  (async () => {
    try {
      const res = await fetch(`${BASE}/chat/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        cb.onError(`stream: ${res.status}`);
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let currentEvent = "message";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        // SSE frames split by blank line
        let nl: number;
        while ((nl = buf.indexOf("\n\n")) !== -1) {
          const frame = buf.slice(0, nl);
          buf = buf.slice(nl + 2);
          currentEvent = "message";
          let dataLine = "";
          for (const line of frame.split("\n")) {
            if (line.startsWith("event:")) currentEvent = line.slice(6).trim();
            else if (line.startsWith("data:")) dataLine += line.slice(5).trim();
          }
          if (!dataLine) continue;
          try {
            const payload = JSON.parse(dataLine);
            if (currentEvent === "evidence") cb.onEvidence?.(payload.ids || []);
            else if (currentEvent === "source_files") cb.onSourceFiles?.(payload.files || []);
            else if (currentEvent === "done") cb.onDone(payload);
            else if (currentEvent === "error") cb.onError(payload.error || "stream error");
            else if (payload.delta) cb.onDelta(payload.delta);
          } catch {
            // ignore malformed frame
          }
        }
      }
    } catch (e) {
      if ((e as { name?: string }).name !== "AbortError") {
        cb.onError(String(e));
      }
    }
  })();

  return () => controller.abort();
}

// Stage 4: Feedback + Strengthen
export async function feedback(
  answerId: number,
  queryText = "",
  feedbackType = "plus_one"
): Promise<FeedbackResponse> {
  const res = await fetch(`${BASE}/feedback`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      answer_id: answerId,
      query_text: queryText,
      feedback_type: feedbackType,
    }),
  });
  return res.json();
}

// Source preview
export async function fetchSource(ref: string): Promise<SourcePreviewData> {
  const res = await fetch(
    `${BASE}/source?ref=${encodeURIComponent(ref)}`
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || `Source fetch failed: ${res.status}`);
  }
  return res.json();
}

// Tags
export type TagInfo = { name: string; desc?: string; color?: string; segments: number; lines: number };
export type TagSegment = {
  id: number;
  source_file: string;
  topic_name?: string;
  line_start: number;
  line_end: number;
  summary: string;
  keywords: string[];
  is_credential: boolean;
};

export async function fetchTags(): Promise<{ tags: TagInfo[] }> {
  const res = await fetch(`${BASE}/tags`);
  return res.json();
}

export async function addTag(name: string, desc = ""): Promise<{ tags: TagInfo[] }> {
  const res = await fetch(`${BASE}/tags/add`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, desc }),
  });
  return res.json();
}

export async function deleteTag(name: string): Promise<{ tags: TagInfo[] }> {
  const res = await fetch(`${BASE}/tags/${encodeURIComponent(name)}`, { method: "DELETE" });
  return res.json();
}

export async function setTagColor(name: string, color: string): Promise<{ tags: TagInfo[] }> {
  const res = await fetch(`${BASE}/tags/color`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, color }),
  });
  return res.json();
}

export async function reorderTags(order: string[]): Promise<{ tags: TagInfo[] }> {
  const res = await fetch(`${BASE}/tags/reorder`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ order }),
  });
  return res.json();
}

export type NoteSegment = TagSegment & { tag: string };

export async function fetchAllTagSegments(): Promise<{ segments: NoteSegment[] }> {
  const res = await fetch(`${BASE}/tags/all-segments`);
  return res.json();
}

export async function fetchTagSegments(tag: string): Promise<{ tag: string; segments: TagSegment[] }> {
  const res = await fetch(`${BASE}/tags/${encodeURIComponent(tag)}`);
  return res.json();
}

// Special Knowledge
export type WikiCategory = "research" | "codebase" | "docs" | "reference";
export type SpecialKnowledgeTopic = {
  id: number | null;
  topic: string;
  summary: string;
  folder: string;
  category: WikiCategory;
  created_at: string | null;
  /** false when the topic was discovered from disk (cloud-pulled but
   *  not yet ingested). Drives the "run ingest to enable search/AI"
   *  prompt. */
  ingested?: boolean;
};

export async function fetchSpecialKnowledge(): Promise<{ topics: SpecialKnowledgeTopic[]; ingest_pending?: number }> {
  const res = await fetch(`${BASE}/special-knowledge`);
  return res.json();
}

export async function deleteSpecialKnowledge(topic: string): Promise<{ deleted: string }> {
  const res = await fetch(`${BASE}/special-knowledge/${encodeURIComponent(topic)}`, { method: "DELETE" });
  return res.json();
}

export type WikiSource = {
  path: string;
  rel_path?: string;
  name: string;
  topic: string;
  category: WikiCategory;
  /** false when the source was found on disk but has no chunks/
   *  tag_segments yet (cloud-pulled but not ingested). */
  ingested?: boolean;
};

export async function fetchWikiSources(): Promise<{ sources: WikiSource[]; base_dir: string; ingest_pending?: number }> {
  const res = await fetch(`${BASE}/wiki-sources`);
  return res.json();
}

// OCR
export async function fetchOcrLangs(): Promise<{ installed: string[]; has_tesseract: boolean; active: string }> {
  const res = await fetch(`${BASE}/ocr-langs`);
  return res.json();
}

export async function saveOcrConfig(ocrLangs: string): Promise<{ ok: boolean; ocr_langs: string }> {
  const res = await fetch(`${BASE}/ocr-langs/config`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ocr_langs: ocrLangs }),
  });
  return res.json();
}

// MCP Servers
export type McpServer = { name: string; url: string; transport: string; auth: Record<string, string> };
export async function fetchMcpServers(): Promise<{ servers: McpServer[] }> {
  const res = await fetch(`${BASE}/mcp/servers`);
  return res.json();
}

export async function addMcpServer(name: string, url: string, transport = "streamable_http"): Promise<{ servers: McpServer[] }> {
  const res = await fetch(`${BASE}/mcp/servers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, url, transport }),
  });
  return res.json();
}

export async function deleteMcpServer(name: string): Promise<{ servers: McpServer[] }> {
  const res = await fetch(`${BASE}/mcp/servers/${encodeURIComponent(name)}`, { method: "DELETE" });
  return res.json();
}

// Wiki import
export async function importWikiUrl(url: string, topicName = ""): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE}/wiki/import-url`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, topic_name: topicName }),
  });
  return res.json();
}

// Builds
export type BuildInfo = {
  id: string;
  source_file: string;
  chunk_count: number;
  segment_count: number;
  is_active: boolean;
  token_usage: Record<string, number>;
  estimated_cost_cny: number;
  tags: Record<string, number>;
  // 'completed' | 'awaiting_enrich' | 'partial'
  enrich_status: string;
  // '' (awaiting) | 'provider:<model>' | 'mcp:delegate' | 'mcp:auto_inherit' | 'fallback'
  completed_by: string;
  // ISO timestamp when status last flipped to awaiting_enrich; null when completed.
  awaiting_since: string | null;
  // Seconds elapsed since awaiting_since; null when not awaiting.
  awaiting_for_seconds: number | null;
  // 'full' (rebuild all) | 'incremental' (accumu)
  ingest_kind: string;
  created_at: string;
};

export async function fetchBuilds(): Promise<{ builds: BuildInfo[] }> {
  const res = await fetch(`${BASE}/builds`);
  return res.json();
}

// Dashboard overview — aggregated stats powering the Dashboard panel.
export type DashboardOverview = {
  counts: Record<string, number>;
  build_attribution: Record<string, number>;
  answer_cache: { entries: number; total_hits: number };
  total_cost_cny: number;
  last_ingest: { id: string; created_at: string; completed_by: string; source_file: string } | null;
  last_wiki_ingest: { id: string; created_at: string; completed_by: string; source_file: string } | null;
  trust_top_chunks: { id: number; source_ref: string; trust_score: number }[];
  recent_gaps: { query_text: string; c: number }[];
};

export async function fetchDashboardOverview(): Promise<DashboardOverview> {
  const res = await fetch(`${BASE}/dashboard/overview`);
  if (!res.ok) throw new Error(`dashboard: ${res.status}`);
  return res.json();
}

// C2 split suggestions — segments that are large AND contain multiple
// sub-headings, i.e. candidates for delegating to a Claude subagent to
// refine into finer-grained segments.
export type SplitSuggestion = {
  segment_id: number;
  source_file: string;
  tag: string;
  topic_name: string;
  line_start: number;
  line_end: number;
  line_count: number;
  subheadings_at: number[];
};

export async function fetchSplitSuggestions(
  minLines = 200,
  minSubheadings = 3,
): Promise<{ suggestions: SplitSuggestion[] }> {
  const res = await fetch(
    `${BASE}/segments/split-suggestions?min_lines=${minLines}&min_subheadings=${minSubheadings}`,
  );
  if (!res.ok) throw new Error(`split-suggestions: ${res.status}`);
  return res.json();
}

// Meta-memory — persistent cross-session learnings Claude has written for
// this knowledge base. Editable so the user stays in control.
export type MetaMemory = {
  id: number;
  kind: string;          // 'rule' | 'vocab' | 'preference' | 'alias' | 'gotcha' | ...
  text: string;
  scope: string;         // 'global' or a tag/topic
  hit_count: number;
  created_at: string;
  updated_at: string;
};

export async function fetchMetaMemories(limit = 200): Promise<{ memories: MetaMemory[] }> {
  const res = await fetch(`${BASE}/meta-memory?limit=${limit}`);
  if (!res.ok) throw new Error(`meta-memory: ${res.status}`);
  return res.json();
}

export async function addMetaMemory(params: { text: string; kind?: string; scope?: string }): Promise<{ id: number; deduped: boolean }> {
  const res = await fetch(`${BASE}/meta-memory`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: params.text,
      kind: params.kind || "rule",
      scope: params.scope || "global",
    }),
  });
  if (!res.ok) throw new Error(`add meta-memory: ${res.status}`);
  return res.json();
}

export async function deleteMetaMemory(id: number): Promise<{ deleted: number }> {
  const res = await fetch(`${BASE}/meta-memory/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`delete meta-memory: ${res.status}`);
  return res.json();
}

// Conflicts — ingest re-classified lines a different way than before. User
// has to pick a side so the segment's tag is no longer split-brain.
export type Conflict = {
  id: number;
  build_id: string;
  source_file: string;
  line_start: number;
  line_end: number;
  existing_tag: string;
  existing_topic: string | null;
  incoming_tag: string;
  incoming_topic: string | null;
  incoming_summary: string | null;
  status: string;
  created_at: string;
};

export type ConflictChoice = "keep_existing" | "accept_incoming" | "dismiss";

export async function fetchConflicts(): Promise<{ conflicts: Conflict[] }> {
  const res = await fetch(`${BASE}/conflicts?status=pending`);
  if (!res.ok) throw new Error(`conflicts: ${res.status}`);
  return res.json();
}

export async function resolveConflict(conflictId: number, choice: ConflictChoice): Promise<{ resolved: number; choice: string }> {
  const res = await fetch(`${BASE}/conflicts/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conflict_id: conflictId, choice }),
  });
  if (!res.ok) throw new Error(`resolve conflict: ${res.status}`);
  return res.json();
}

// Enrich queue — delegate-mode ingests with classifications pending.
// If it sits here too long, segments stay invisible to tag filters.
export type EnrichQueueSummary = {
  kind: string;
  note_segments?: { pending_builds: number; builds: { build_id: string; source_file: string; chunks: number }[] };
  wiki_chunks?: { pending_chunks: number };
  wiki_topic?: { pending_topics: number };
  doc_format?: { pending_docs: number };
};

export async function fetchEnrichQueue(): Promise<EnrichQueueSummary> {
  const res = await fetch(`${BASE}/enrich-queue?kind=summary`);
  if (!res.ok) throw new Error(`enrich-queue: ${res.status}`);
  return res.json();
}

// Skills — reusable recipes from notes, read and executed by any CLI
// (Claude Code, Cursor, OpenCode). SmartNote stores the recipe; it does not
// execute. The UI shows them read-only; new ones come from upload_skill.
export type SkillNode = {
  name: string;
  description?: string;
  trigger_hints?: string[];
  expected_tag?: string;
};

export type SkillTemplate = {
  id: number;
  name: string;
  description: string;
  kind: "periodic" | "sequence";
  period_hint: "daily" | "weekly" | "monthly" | "ad_hoc";
  nodes: SkillNode[];
  source_segment_ids: number[];
  created_at: string;
  updated_at: string;
};

export type SkillRunStep = {
  name: string;
  status?: string;
  evidence_chunk_ids?: number[];
  notes?: string;
};

export type SkillRun = {
  id: number;
  template_id: number;
  slice_start_ts: string;
  slice_end_ts: string;
  status: "pending_exec" | "completed" | "skipped";
  result_summary: string;
  steps: SkillRunStep[];
  triggered_by: string;
  started_at: string;
  finished_at: string | null;
};

export type SkillRunBundle = {
  run: SkillRun;
  bundle: {
    template: SkillTemplate;
    slice: {
      slice_start_ts: string;
      slice_end_ts: string;
      chunk_count: number;
      chunks: { id: number; source_ref: string; text: string; note_ts: string }[];
    };
  };
};

export async function fetchSkills(): Promise<{ templates: SkillTemplate[] }> {
  const res = await fetch(`${BASE}/skills`);
  if (!res.ok) throw new Error(`skills: ${res.status}`);
  return res.json();
}

export async function runSkill(name: string, sliceDays = 7): Promise<SkillRunBundle> {
  const res = await fetch(`${BASE}/skills/${encodeURIComponent(name)}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ slice_days: sliceDays, triggered_by: "ui" }),
  });
  if (!res.ok) throw new Error(`run skill: ${res.status}`);
  return res.json();
}

export async function fetchSkillRuns(templateId?: number): Promise<{ runs: SkillRun[] }> {
  const url = templateId
    ? `${BASE}/skill-runs?template_id=${templateId}&limit=20`
    : `${BASE}/skill-runs?limit=20`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`skill runs: ${res.status}`);
  return res.json();
}

export async function deleteSkill(templateId: number): Promise<void> {
  await fetch(`${BASE}/skills/${templateId}`, { method: "DELETE" });
}

// Partial field update. Only text fields can be changed — structural
// changes (add/remove/reorder nodes) must go through the full POST.
export type SkillNodePatch = {
  index: number;
  name?: string;
  description?: string;
  trigger_hints?: string[];
  expected_tag?: string;
};

export type SkillPatchBody = {
  description?: string;
  new_name?: string;
  kind?: "periodic" | "sequence";
  period_hint?: "daily" | "weekly" | "monthly" | "ad_hoc";
  nodes?: SkillNodePatch[];
};

export async function patchSkill(name: string, body: SkillPatchBody): Promise<SkillTemplate> {
  const res = await fetch(`${BASE}/skills/${encodeURIComponent(name)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || `skill patch: ${res.status}`);
  }
  return res.json();
}

export type SmartTableSummary = {
  id: number;
  name: string;
  created_at: string;
  updated_at: string;
  sheet_count: number;
  row_count: number;
};

export type SmartSheetSummary = {
  id: number;
  table_id: number;
  name: string;
  ord: number;
  created_at: string;
  updated_at: string;
  column_count: number;
  row_count: number;
};

export type SmartColumn = {
  id: number;
  sheet_id: number;
  name: string;
  type: "text" | "link" | "image";
  ord: number;
  created_at: string;
  updated_at: string;
};

export type SmartCellValue = Record<string, unknown>;

export type SmartRow = {
  id: number;
  sheet_id: number;
  ord: number;
  created_at: string;
  updated_at: string;
  cells: Record<string, SmartCellValue>;
};

export type SmartCellHistoryItem = {
  id: number;
  row_id: number;
  column_id: number;
  old_value: SmartCellValue | null;
  new_value: SmartCellValue | null;
  changed_at: string;
  source: string;
};

export type SmartSheetPayload = {
  sheet: {
    id: number;
    table_id: number;
    table_name: string;
    name: string;
    ord: number;
    created_at: string;
    updated_at: string;
  };
  columns: SmartColumn[];
  rows: SmartRow[];
};

export async function fetchSmartTables(): Promise<{ tables: SmartTableSummary[] }> {
  const res = await fetch(`${BASE}/smart-tables`);
  if (!res.ok) throw new Error(`smart-tables: ${res.status}`);
  return res.json();
}

export async function createSmartTable(name: string): Promise<{ table: SmartTableSummary }> {
  const res = await fetch(`${BASE}/smart-tables`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || `create smart table: ${res.status}`);
  }
  return res.json();
}

export async function deleteSmartTable(tableName: string): Promise<{ ok: boolean; deleted_table: string }> {
  const res = await fetch(`${BASE}/smart-tables/${encodeURIComponent(tableName)}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || `delete smart table: ${res.status}`);
  }
  return res.json();
}

export async function fetchSmartSheets(tableName: string): Promise<{ sheets: SmartSheetSummary[] }> {
  const res = await fetch(`${BASE}/smart-tables/${encodeURIComponent(tableName)}/sheets`);
  if (!res.ok) throw new Error(`smart sheets: ${res.status}`);
  return res.json();
}

export async function createSmartSheet(tableName: string, name: string): Promise<{ sheet: SmartSheetSummary }> {
  const res = await fetch(`${BASE}/smart-tables/${encodeURIComponent(tableName)}/sheets`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || `create smart sheet: ${res.status}`);
  }
  return res.json();
}

export async function renameSmartSheet(tableName: string, sheetName: string, newName: string): Promise<{ sheet: SmartSheetSummary }> {
  const res = await fetch(`${BASE}/smart-tables/${encodeURIComponent(tableName)}/sheets/${encodeURIComponent(sheetName)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ new_name: newName }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || `rename smart sheet: ${res.status}`);
  }
  return res.json();
}

export async function addSmartColumn(tableName: string, sheetName: string, name: string, type: SmartColumn["type"]): Promise<{ column: SmartColumn }> {
  const res = await fetch(`${BASE}/smart-tables/${encodeURIComponent(tableName)}/sheets/${encodeURIComponent(sheetName)}/columns`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, type }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || `add smart column: ${res.status}`);
  }
  return res.json();
}

export async function renameSmartColumn(tableName: string, sheetName: string, columnName: string, newName: string): Promise<{ column: SmartColumn }> {
  const res = await fetch(`${BASE}/smart-tables/${encodeURIComponent(tableName)}/sheets/${encodeURIComponent(sheetName)}/columns/${encodeURIComponent(columnName)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ new_name: newName }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || `rename smart column: ${res.status}`);
  }
  return res.json();
}

export async function deleteSmartColumn(tableName: string, sheetName: string, columnName: string): Promise<{ ok: boolean; deleted_column: string }> {
  const res = await fetch(`${BASE}/smart-tables/${encodeURIComponent(tableName)}/sheets/${encodeURIComponent(sheetName)}/columns/${encodeURIComponent(columnName)}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || `delete smart column: ${res.status}`);
  }
  return res.json();
}

export async function fetchSmartSheet(tableName: string, sheetName: string): Promise<SmartSheetPayload> {
  const res = await fetch(`${BASE}/smart-tables/${encodeURIComponent(tableName)}/sheets/${encodeURIComponent(sheetName)}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || `smart sheet: ${res.status}`);
  }
  return res.json();
}

export async function updateSmartCell(
  tableName: string,
  sheetName: string,
  rowId: number,
  columnName: string,
  value: SmartCellValue | string,
  source = "ui"
): Promise<SmartSheetPayload> {
  const res = await fetch(`${BASE}/smart-tables/${encodeURIComponent(tableName)}/sheets/${encodeURIComponent(sheetName)}/cells`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ row_id: rowId, column_name: columnName, value, source }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || `update smart cell: ${res.status}`);
  }
  return res.json();
}

export async function addSmartRow(
  tableName: string,
  sheetName: string,
  values: Record<string, SmartCellValue | string> = {},
  source = "ui"
): Promise<{ row: { id: number; sheet_id: number; ord: number; created_at: string; updated_at: string } }> {
  const res = await fetch(`${BASE}/smart-tables/${encodeURIComponent(tableName)}/sheets/${encodeURIComponent(sheetName)}/rows`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ values, source }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || `add smart row: ${res.status}`);
  }
  return res.json();
}

export async function deleteSmartRow(tableName: string, sheetName: string, rowId: number): Promise<{ ok: boolean; deleted_row_id: number }> {
  const res = await fetch(`${BASE}/smart-tables/${encodeURIComponent(tableName)}/sheets/${encodeURIComponent(sheetName)}/rows/${rowId}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || `delete smart row: ${res.status}`);
  }
  return res.json();
}

export async function fetchSmartCellHistory(
  tableName: string,
  sheetName: string,
  rowId: number,
  columnName: string
): Promise<{ history: SmartCellHistoryItem[] }> {
  const q = new URLSearchParams({ row_id: String(rowId), column_name: columnName });
  const res = await fetch(`${BASE}/smart-tables/${encodeURIComponent(tableName)}/sheets/${encodeURIComponent(sheetName)}/history?${q.toString()}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || `smart cell history: ${res.status}`);
  }
  return res.json();
}

export async function uploadSmartTableImage(file: File): Promise<{ image: { filename: string; relative_path: string; url: string } }> {
  const body = new FormData();
  body.append("file", file);
  const res = await fetch(`${BASE}/smart-tables/images`, {
    method: "POST",
    body,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || `smart table image upload: ${res.status}`);
  }
  return res.json();
}

// Ingest packs — each save or external edit creates a pending pack,
// surfaced in the bottom-right badge until the user applies or discards.
export type PackChange = {
  op: "insert" | "delete" | "replace";
  line: number;           // 1-based line number in the NEW file (jump target)
  range: [number, number]; // [start, end] inclusive; end < start means pure delete at `line`
  chars_added: number;
  chars_removed: number;
  chars: number;           // signed delta = added - removed
  preview: string;
};

export type IngestPack = {
  id: number;
  raw_path: string;
  kind: "in_app" | "external";
  diff_patch: string;
  before_md5: string;
  after_md5: string;
  lines_added: number;
  lines_removed: number;
  byte_delta: number;
  note: string;
  status: "pending" | "applied" | "discarded" | "merged";
  merged_into: number | null;
  applied_build_id: string | null;
  changes: PackChange[];
  created_at: string;
  applied_at: string | null;
};

export type NoteLineMeta = {
  line_no_last: number;
  line_hash: string;
  line_preview: string;
  ts: string | null;
  bookmark: string;
  highlight_color: string;
  highlight_note: string;
  updated_at: string;
};

export type NoteFileState = {
  file_path: string;
  md5: string;
  mtime: number | null;
  line_count: number;
  byte_size: number;
};

export async function saveNote(rawPath: string, content: string, note = ""): Promise<{ pack: IngestPack; file_state: NoteFileState; lines_stamped: number }> {
  const res = await fetch(`${BASE}/note/save`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ raw_path: rawPath, content, note }),
  });
  if (!res.ok) throw new Error(`save note: ${res.status}`);
  return res.json();
}

export async function loadNote(rawPath: string): Promise<{ exists: boolean; content: string; file_state: NoteFileState | null; external_pack_created: boolean; external_pack: IngestPack | null }> {
  const res = await fetch(`${BASE}/note/load?raw_path=${encodeURIComponent(rawPath)}`);
  if (!res.ok) throw new Error(`load note: ${res.status}`);
  return res.json();
}

export async function fetchNoteLineMeta(rawPath: string): Promise<{ lines: NoteLineMeta[] }> {
  const res = await fetch(`${BASE}/note/line-meta?raw_path=${encodeURIComponent(rawPath)}`);
  if (!res.ok) throw new Error(`line-meta: ${res.status}`);
  return res.json();
}

// Compute the canonical line_hash the backend uses. Must match
// server/app/packs.py::_line_hash — sha256 of trimmed line, first 16 hex.
export async function lineHash(line: string): Promise<string> {
  const trimmed = line.trim();
  const buf = new TextEncoder().encode(trimmed);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest).slice(0, 8))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function setLineMark(
  rawPath: string,
  lineHashValue: string,
  marks: {
    bookmark?: string;
    highlight_color?: string;
    highlight_note?: string;
    line_preview?: string;
    line_no?: number;
  }
): Promise<NoteLineMeta> {
  const res = await fetch(`${BASE}/note/line-mark`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ raw_path: rawPath, line_hash: lineHashValue, ...marks }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || `line-mark: ${res.status}`);
  }
  return res.json();
}

// ── Note views (topical lenses over a single raw file) ──────────

export type ViewRule = {
  keywords?: string[];
  regex?: string;
  ai_query?: string;
};

export type ViewDisplay = {
  // Per-view display knobs; everything is optional and falls back to the
  // app-wide defaults when absent. Colors still come from the app theme.
  dim_level?: "light" | "medium" | "heavy";    // how hard to dim non-members
  dim_mode?: "opacity" | "frost";              // blur vs. just fade
  show_tags?: boolean;
  show_ts?: boolean;
  show_bookmarks?: boolean;
  density?: "comfortable" | "compact";
};

export type NoteView = {
  id: number;
  raw_path: string;
  name: string;
  rule: ViewRule;
  display: ViewDisplay;
  sort_order: number;
  member_count?: number;
  created_at: string;
  updated_at: string;
};

export type ViewResolvedLine = {
  line_no: number;
  line_hash: string;
  text: string;
  source: "rule" | "ai" | "manual";
};

export async function fetchViews(rawPath: string): Promise<{ views: NoteView[] }> {
  const res = await fetch(`${BASE}/note/views?raw_path=${encodeURIComponent(rawPath)}`);
  if (!res.ok) throw new Error(`views: ${res.status}`);
  return res.json();
}

export async function createView(
  rawPath: string,
  name: string,
  rule?: ViewRule,
  display?: ViewDisplay,
): Promise<{ view: NoteView }> {
  const res = await fetch(`${BASE}/note/views`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ raw_path: rawPath, name, rule, display }),
  });
  if (!res.ok) throw new Error(`create view: ${res.status}`);
  return res.json();
}

export async function updateView(
  viewId: number,
  patch: { name?: string; rule?: ViewRule; display?: ViewDisplay; sort_order?: number },
): Promise<{ view: NoteView }> {
  const res = await fetch(`${BASE}/note/views/${viewId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`update view: ${res.status}`);
  return res.json();
}

export async function deleteView(viewId: number): Promise<{ ok: boolean }> {
  const res = await fetch(`${BASE}/note/views/${viewId}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`delete view: ${res.status}`);
  return res.json();
}

/** Populate response includes a `diff` block when dry_run=true so the
 *  caller can show a before/after review modal before committing. */
export type PopulateDiff = {
  added: { line_hash: string; source: string; preview: string; was?: string }[];
  removed: { line_hash: string; source: string; preview: string }[];
  source_changed: { line_hash: string; from: string; to: string; preview: string }[];
  unchanged_count: number;
};

export type PopulateResult = {
  ok: boolean;
  dry_run: boolean;
  rule_hits?: number;
  ai_hits?: number;
  total_hits?: number;
  diff?: PopulateDiff;
};

export async function populateView(
  viewId: number,
  opts: { rule?: ViewRule; replace?: boolean; dry_run?: boolean } = {},
): Promise<PopulateResult> {
  const res = await fetch(`${BASE}/note/views/${viewId}/populate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(opts),
  });
  if (!res.ok) throw new Error(`populate: ${res.status}`);
  return res.json();
}

export async function setViewMembers(
  viewId: number,
  ops: {
    add?: { line_hash: string; line_preview?: string }[];
    remove?: string[];
    exclude?: { line_hash: string; line_preview?: string }[];
  },
): Promise<{ count: number }> {
  const res = await fetch(`${BASE}/note/views/${viewId}/members`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(ops),
  });
  if (!res.ok) throw new Error(`view members: ${res.status}`);
  return res.json();
}

export async function resolveView(
  viewId: number,
  rawPath?: string,
): Promise<{ lines: ViewResolvedLine[]; missing: string[] }> {
  const q = rawPath ? `?raw_path=${encodeURIComponent(rawPath)}` : "";
  const res = await fetch(`${BASE}/note/views/${viewId}/resolve${q}`);
  if (!res.ok) throw new Error(`resolve view: ${res.status}`);
  return res.json();
}

export async function fetchPacks(rawPath?: string, status: "pending" | "applied" | "discarded" | "all" = "pending"): Promise<{ packs: IngestPack[]; pending_count: number }> {
  const q = new URLSearchParams({ status, ...(rawPath ? { raw_path: rawPath } : {}) });
  const res = await fetch(`${BASE}/packs?${q.toString()}`);
  if (!res.ok) throw new Error(`packs: ${res.status}`);
  return res.json();
}

export type PackStats = {
  applied_since_full: number;
  pending: number;
  last_full_build_id: string | null;
  last_full_at: string | null;
};

export async function fetchPackStats(rawPath: string): Promise<PackStats> {
  const q = new URLSearchParams({ raw_path: rawPath });
  const res = await fetch(`${BASE}/packs/stats?${q.toString()}`);
  if (!res.ok) throw new Error(`pack stats: ${res.status}`);
  return res.json();
}

export async function applyPack(packId: number): Promise<{ pack: IngestPack; build_id: string | null; applied_siblings_count: number }> {
  const res = await fetch(`${BASE}/packs/${packId}/apply`, { method: "POST" });
  if (!res.ok) throw new Error(`apply pack: ${res.status}`);
  return res.json();
}

export async function applyAllPacks(rawPath: string): Promise<{ applied: number; build_id: string | null }> {
  const res = await fetch(`${BASE}/packs/apply-all`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ raw_path: rawPath }),
  });
  if (!res.ok) throw new Error(`apply-all: ${res.status}`);
  return res.json();
}

export async function discardPack(packId: number): Promise<IngestPack> {
  const res = await fetch(`${BASE}/packs/${packId}/discard`, { method: "POST" });
  if (!res.ok) throw new Error(`discard pack: ${res.status}`);
  return res.json();
}

export async function mergePacks(packIds: number[]): Promise<IngestPack> {
  const res = await fetch(`${BASE}/packs/merge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pack_ids: packIds }),
  });
  if (!res.ok) throw new Error(`merge packs: ${res.status}`);
  return res.json();
}

// Reorganize by tag — destructive rewrite of raw.md into tag-grouped
// sections. Preview first, approve commits with snapshot + reset ingest.
export type ReorganizePreview = {
  raw_path: string;
  before: string;
  candidate: string;
  line_count_before: number;
  line_count_after: number;
  tags_used: string[];
  unclassified_lines: number;
  warning: string;
};

export async function previewReorganize(rawPath: string): Promise<ReorganizePreview> {
  const res = await fetch(`${BASE}/note/reorganize-preview`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ raw_path: rawPath }),
  });
  if (!res.ok) throw new Error(`reorganize preview: ${res.status}`);
  return res.json();
}

export async function approveReorganize(rawPath: string, candidate: string, notePath?: string): Promise<{ raw_path: string; build_id: string | null; snapshot: { id: string; path: string }; packs_closed: number; bytes_written: number }> {
  const res = await fetch(`${BASE}/note/reorganize-approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ raw_path: rawPath, candidate, ...(notePath ? { note_path: notePath } : {}) }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || `reorganize approve: ${res.status}`);
  }
  return res.json();
}

export async function activateBuild(buildId: string): Promise<void> {
  await fetch(`${BASE}/builds/activate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ build_id: buildId }),
  });
}

export async function deleteBuild(buildId: string): Promise<void> {
  await fetch(`${BASE}/builds/${encodeURIComponent(buildId)}`, { method: "DELETE" });
}

export async function fetchGraph(): Promise<GraphData> {
  const res = await fetch(`${BASE}/graph`);
  return res.json();
}

// Wiki document graph
export type WikiGraphNode = {
  id: string;
  name: string;
  summary: string;
  folder: string;
  files: { path: string; chunks: number }[];
  chunk_count: number;
  is_note?: boolean;
};

export type WikiGraphEdge = {
  source: string;
  target: string;
  similarity?: number;
  shared_keywords?: string[];
  weight: number;
};

export type WikiGraphData = {
  nodes: WikiGraphNode[];
  edges: WikiGraphEdge[];
};

export async function fetchWikiGraph(): Promise<WikiGraphData> {
  const res = await fetch(`${BASE}/wiki-graph`);
  return res.json();
}

// ── SmartNote Cloud sync ────────────────────────────────────────

export type CloudSyncStatus = {
  enabled: boolean;
  configured: boolean;
  cloud_url: string;
  entities: { local_kind: string; count: number; last_push: string | null; last_pull: string | null }[];
  conflicts: number;
};

export async function fetchCloudSyncStatus(): Promise<CloudSyncStatus> {
  const res = await fetch(`${BASE}/sync/status`);
  if (!res.ok) throw new Error(`sync status: ${res.status}`);
  return res.json();
}

export async function testCloudSync(
  override?: { url?: string; api_key?: string },
): Promise<{ ok: boolean; workspace?: unknown; error?: string }> {
  // When the Settings UI calls this, pass the form values so a user
  // can verify credentials BEFORE hitting the main Save button.
  // Omitting the body falls back to the backend's persisted settings.
  const res = await fetch(`${BASE}/sync/test`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(override || {}),
  });
  return res.json();
}

/** Persist just the three cloud-sync keys without touching other
 *  Settings fields. Used by the Cloud Sync section's inline Save
 *  button so the other panels don't flush half-edited state. */
export async function saveCloudSyncSettings(patch: {
  cloud_sync_enabled?: boolean;
  cloud_sync_url?: string;
  cloud_sync_api_key?: string;
}): Promise<{ ok: boolean }> {
  const res = await fetch(`${BASE}/settings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`save cloud sync: ${res.status}`);
  return res.json();
}

export async function triggerSyncFull(): Promise<unknown> {
  const res = await fetch(`${BASE}/sync/full`, { method: "POST" });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(detail.detail || `sync failed: ${res.status}`);
  }
  return res.json();
}

export async function triggerSyncPush(): Promise<unknown> {
  const res = await fetch(`${BASE}/sync/push`, { method: "POST" });
  if (!res.ok) throw new Error(`sync push: ${res.status}`);
  return res.json();
}

export async function triggerSyncPull(opts: { force?: boolean } = {}): Promise<unknown> {
  const url = opts.force ? `${BASE}/sync/pull?force=true` : `${BASE}/sync/pull`;
  const res = await fetch(url, { method: "POST" });
  if (!res.ok) throw new Error(`sync pull: ${res.status}`);
  return res.json();
}

export type SyncPullPreviewRow = {
  cloud_doc_id?: string;
  name?: string;
  kind?: string;
  local_id?: string;
  local_size?: number;
  remote_size?: number;
  action: "new" | "in-sync" | "would-overwrite-clean" | "would-overwrite-conflict" | "skip" | "error";
  reason?: string;
  error?: string;
};

export type SyncPullPreview = {
  counts: Record<SyncPullPreviewRow["action"], number>;
  rows: SyncPullPreviewRow[];
};

export async function fetchSyncPullPreview(): Promise<SyncPullPreview> {
  const res = await fetch(`${BASE}/sync/pull-preview`, { method: "POST" });
  if (!res.ok) throw new Error(`pull preview: ${res.status}`);
  return res.json();
}

export type DedupeSummary = Record<string, { kept: number; deleted: number; errors: number; error?: string }>;

export async function dedupeCloudDocs(): Promise<DedupeSummary> {
  const res = await fetch(`${BASE}/sync/dedupe-cloud`, { method: "POST" });
  if (!res.ok) throw new Error(`dedupe: ${res.status}`);
  return res.json();
}

export type CloudSyncPreview = {
  total_items: number;
  total_new: number;
  total_changed: number;
  total_bytes: number;
  kinds: Record<string, {
    count: number;
    new: number;
    changed: number;
    unchanged: number;
    total_bytes: number;
    items: { local_id: string; name: string; size: number; status: "new" | "changed" | "unchanged" }[];
    truncated: boolean;
  }>;
};

export async function fetchCloudSyncPreview(): Promise<CloudSyncPreview> {
  const res = await fetch(`${BASE}/sync/preview`);
  if (!res.ok) throw new Error(`preview: ${res.status}`);
  return res.json();
}

export async function pushSyncOne(
  kind: string,
  localId: string,
  signal?: AbortSignal,
): Promise<{ action: string; cloud_doc_id?: string; error?: string }> {
  const res = await fetch(`${BASE}/sync/push-one`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind, local_id: localId }),
    signal,
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(detail.detail || `push-one: ${res.status}`);
  }
  return res.json();
}

// ── Cloud proposal queue (proxied via local gateway) ─────────────

export type CloudProposal = {
  id: string;
  workspace_id: string;
  author_agent: string;
  kind: string;
  scope: string;
  content: string;
  structured?: Record<string, unknown> | null;
  tags: string[];
  source_refs: Record<string, unknown>[];
  confidence: number;
  proposal_reason?: string | null;
  created_at: string;
  similar_existing?: { id: string; kind: string; content: string; similarity: number }[];
};

export async function fetchCloudProposals(
  opts: { kind?: string; limit?: number } = {},
): Promise<{ proposals: CloudProposal[]; total: number }> {
  const q = new URLSearchParams();
  if (opts.kind) q.set("kind", opts.kind);
  if (opts.limit) q.set("limit", String(opts.limit));
  const res = await fetch(`${BASE}/sync/proposals?${q.toString()}`);
  if (!res.ok) throw new Error(`proposals list: ${res.status}`);
  return res.json();
}

export async function acceptCloudProposal(
  id: string,
  patch: { content?: string; tags?: string[]; pinned?: boolean; confidence?: number; supersedes?: string } = {},
): Promise<unknown> {
  const res = await fetch(`${BASE}/sync/proposals/${id}/accept`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`accept proposal: ${res.status}`);
  return res.json();
}

export async function rejectCloudProposal(id: string, reason?: string): Promise<unknown> {
  const res = await fetch(`${BASE}/sync/proposals/${id}/reject`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reason }),
  });
  if (!res.ok) throw new Error(`reject proposal: ${res.status}`);
  return res.json();
}

export async function batchAcceptCloudProposals(ids: string[]): Promise<{ accepted: number }> {
  const res = await fetch(`${BASE}/sync/proposals/batch-accept`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids }),
  });
  if (!res.ok) throw new Error(`batch accept: ${res.status}`);
  return res.json();
}
