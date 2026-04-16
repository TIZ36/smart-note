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
export async function search(
  query: string,
  topk = 20,
  tagFilter?: string | null,
  includeWiki?: string[]
): Promise<SearchResponse> {
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
export type SpecialKnowledgeTopic = { id: number; topic: string; summary: string; folder: string; category: WikiCategory; created_at: string };

export async function fetchSpecialKnowledge(): Promise<{ topics: SpecialKnowledgeTopic[] }> {
  const res = await fetch(`${BASE}/special-knowledge`);
  return res.json();
}

export async function deleteSpecialKnowledge(topic: string): Promise<{ deleted: string }> {
  const res = await fetch(`${BASE}/special-knowledge/${encodeURIComponent(topic)}`, { method: "DELETE" });
  return res.json();
}

export type WikiSource = { path: string; rel_path?: string; name: string; topic: string; category: WikiCategory };

export async function fetchWikiSources(): Promise<{ sources: WikiSource[]; base_dir: string }> {
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
