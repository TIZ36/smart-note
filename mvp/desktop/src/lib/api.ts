import type {
  Health,
  SearchResponse,
  ChatResponse,
  FeedbackResponse,
  GraphData,
  RerankResponse,
  SourcePreviewData,
} from "./types";

const BASE = "http://127.0.0.1:8787";

export async function fetchHealth(): Promise<Health> {
  const res = await fetch(`${BASE}/health`);
  return res.json();
}

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
  topk = 10
): Promise<ChatResponse> {
  const res = await fetch(`${BASE}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, evidence_ids: evidenceIds, history, topk }),
  });
  return res.json();
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

// Version management
export type VersionInfo = {
  version: string;
  reason: string;
  created_at: string;
  chunk_count: number;
  path?: string;
};

export async function listVersions(): Promise<{ versions: VersionInfo[] }> {
  const res = await fetch(`${BASE}/versions`);
  return res.json();
}

export async function restoreVersion(
  versionId: string,
  notePath: string
): Promise<{ restored: string; chunk_count: number }> {
  const res = await fetch(`${BASE}/versions/restore`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ version_id: versionId, note_path: notePath }),
  });
  return res.json();
}

// Rewrite (lossless reorganization)
export type RewriteStatus = {
  active: boolean;
  id?: number;
  source_file?: string;
  candidate_path?: string;
  status?: string;
  days_elapsed?: number;
  days_remaining?: number;
  total_queries?: number;
  candidate_wins?: number;
  old_wins?: number;
  ties?: number;
  candidate_win_rate?: number;
  can_approve?: boolean;
};

export async function generateRewrite(
  rawPath: string,
  notePath: string
): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE}/rewrite/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ raw_path: rawPath, note_path: notePath }),
  });
  return res.json();
}

export async function getRewriteStatus(): Promise<RewriteStatus> {
  const res = await fetch(`${BASE}/rewrite/status`);
  return res.json();
}

export async function approveRewrite(candidateId: number): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE}/rewrite/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ candidate_id: candidateId }),
  });
  return res.json();
}

export async function rejectRewrite(candidateId: number): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE}/rewrite/reject`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ candidate_id: candidateId }),
  });
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

export async function fetchTagSource(tag: string, segmentId: number): Promise<{ file: string; line_start: number; line_end: number; lines: { line: number; text: string }[] }> {
  const res = await fetch(`${BASE}/tags/${encodeURIComponent(tag)}/source?segment_id=${segmentId}`);
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

export type WikiSource = { path: string; name: string; topic: string; category: WikiCategory };

export async function fetchWikiSources(): Promise<{ sources: WikiSource[] }> {
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
export type McpTool = { name: string; description: string; input_schema: Record<string, unknown> };
export type McpResource = { uri: string; name: string; description: string; mimeType: string };

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

export async function fetchMcpTools(serverName: string): Promise<{ tools: McpTool[] }> {
  const res = await fetch(`${BASE}/mcp/servers/${encodeURIComponent(serverName)}/tools`);
  return res.json();
}

export async function callMcpTool(serverName: string, toolName: string, args: Record<string, unknown> = {}): Promise<{ content: string }> {
  const res = await fetch(`${BASE}/mcp/servers/${encodeURIComponent(serverName)}/call`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tool_name: toolName, arguments: args }),
  });
  return res.json();
}

export async function fetchMcpResources(serverName: string): Promise<{ resources: McpResource[] }> {
  const res = await fetch(`${BASE}/mcp/servers/${encodeURIComponent(serverName)}/resources`);
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

export async function importWikiMcp(serverName: string, opts: { doc_url?: string; document_id?: string; topic_name?: string }): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE}/wiki/import-mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ server_name: serverName, ...opts }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || `Import failed: ${res.status}`);
  }
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
  created_at: string;
};

export async function fetchBuilds(): Promise<{ builds: BuildInfo[] }> {
  const res = await fetch(`${BASE}/builds`);
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
};

export type WikiGraphEdge = {
  source: string;
  target: string;
  shared_keywords: string[];
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
