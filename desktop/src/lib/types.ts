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

/** Per-path breakdown powering the "6-path fusion" chip row. Only
 *  non-zero paths are rendered in the UI; this is how we make the
 *  hybrid retrieval visible vs naive single-path RAG. */
export type SearchResultPathScores = {
  fts: number;        // Path 1: FTS5 full-text
  sub: number;        // Path 2: LIKE substring
  ngram: number;      // Path 3: char n-gram
  vec: number;        // Path 4: cosine similarity on embeddings
  kw: number;         // Path 5: keyword overlap
  tag_meta: number;   // Path 6: tag segment topic/summary/kw match
};

export type SearchResult = {
  id: number | string;
  text: string;
  source_ref: string;
  dimension: string;
  project_slug?: string | null;
  fts?: number;       // legacy — may be absent; path_scores is canonical
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
  path_scores?: SearchResultPathScores;
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
  // Master kill switch for all LLM calls (chat answers, rerank, rewrite,
  // ingest enrich, wiki topic summaries). Embedding continues to work.
  ai_features_enabled: boolean;
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
  // SmartNote Cloud sync — bidirectional sync of notes/wiki/smart tables
  // to the cloud API. Empty URL + key = feature off even if flag is true.
  cloud_sync_enabled?: boolean;
  cloud_sync_url?: string;
  cloud_sync_api_key?: string;
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

/* v3 stream-centric routes. Closed union so the router catches typos.
 *
 *   stream             default home — Stream surface (RAG queries + history + agent activity)
 *   note               full-canvas markdown editor (read/write only — no AI triggers)
 *   library:docs       Library tab — wiki documents (was "special-knowledge")
 *   library:memories   Library tab — agent-proposed + daily-digest memories
 *   library:skills     Library tab — claude/cursor/opencode skill files + workflows
 *   rag                Knowledge processing center — pick notes/wiki sources, trigger
 *                      embedding/enrich/tag/graph, manage 6-path retrieval + tag CRUD.
 *                      Note + Library stay read-only; this is where AI capabilities fire.
 *   settings           full-canvas settings (200px sub-nav inside)
 *   source:<path>      raw markdown viewer for a single source file
 *
 * Cloud lives as a center modal toggle on AtelierShell, not a channel.
 */
export type ChannelId =
  | "stream"
  | "note"
  | "library:docs"
  | "library:memories"
  | "library:skills"
  | "rag"
  | "settings"
  | `source:${string}`;
