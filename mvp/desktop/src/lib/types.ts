export type Health = {
  status: string;
  embedding_mode: string;
};

export type MvpStatus = {
  gateway_online: boolean;
  embedding_mode: string;
};

export type CmdResult = {
  ok: boolean;
  output: string;
};

export type ViewsResult = {
  views: { name: string; path: string }[];
};

export type ViewItem = {
  key: string;
  title: string;
  path: string;
};

export type SearchResult = {
  id: number | string;
  text: string;
  source_ref: string;
  dimension: string;
  project_slug?: string | null;
  fts?: number;
  vec?: number;
  kw?: number;
  mem?: number;
  score: number;
  rerank_score?: number;
  _reranked?: boolean;
  _tagColor?: string;
  segment_range?: string;
  segment_topic?: string;
  is_wiki?: boolean;
};

export type SearchResponse = {
  results: SearchResult[];
  latency_ms: number;
  total_recall?: number;
  weights_used?: Record<string, number>;
  is_adaptive?: boolean;
  wiki_topics_found?: Record<string, number>;
};

export type RerankResponse = {
  results: SearchResult[];
  latency_ms: number;
};

export type SourceLine = {
  line: number;
  text: string;
  highlight: boolean;
};

export type SourcePreviewData = {
  file: string;
  target_line: number;
  lines: SourceLine[];
};

export type ChatResponse = {
  answer_id: number;
  answer: string;
  evidence: SearchResult[];
  latency_ms: number;
  source_files?: string[];
};

export type FeedbackResponse = {
  status: string;
};

export type AppSettings = {
  embedding_mode: string;
  // Chat / AI provider
  provider_base_url: string;
  provider_api_key: string;
  provider_chat_model: string;
  // Embedding provider (separate, falls back to chat if empty)
  embed_base_url: string;
  embed_api_key: string;
  provider_embed_model: string;
  // AI ingestion
  ingest_ai_enabled: boolean;
  ingest_ai_model: string;
};

export type GraphNode = {
  id: number;
  name: string;
  type: string;
  mentions: number;
};

export type GraphEdge = {
  source: number;
  target: number;
  relation: string;
  weight: number;
};

export type GraphStats = {
  total_chunks: number;
  total_entities: number;
  total_memories: number;
  total_feedback: number;
  tags: Record<string, { segments: number; lines: number }>;
};

export type GraphData = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  tag_entities?: Record<string, { name: string; count: number }[]>;
  stats: GraphStats;
};

export type ActiveServer = "kb" | "settings";

export type ChannelId =
  | "search"
  | "raw-input"
  | "settings"
  | string; // dimension view channels like "todo", "requirements", "project-0"
