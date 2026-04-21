export type MemoryKind = "fact" | "preference" | "procedure" | "episode" | "document_ref";

export interface Memory {
  id: string;
  workspace_id: string;
  author_agent: string;
  kind: MemoryKind;
  scope: string;
  content: string;
  structured?: Record<string, unknown> | null;
  tags: string[];
  source_refs: Record<string, unknown>[];
  confidence: number;
  pinned: boolean;
  supersedes?: string | null;
  created_at: string;
  updated_at: string;
}

export interface MemoryAddInput {
  kind: MemoryKind;
  content: string;
  scope?: string;
  structured?: Record<string, unknown>;
  tags?: string[];
  source_refs?: Record<string, unknown>[];
  confidence?: number;
  pinned?: boolean;
  supersedes?: string;
}

export interface MemoryPatchInput {
  content?: string;
  scope?: string;
  structured?: Record<string, unknown>;
  tags?: string[];
  source_refs?: Record<string, unknown>[];
  confidence?: number;
  pinned?: boolean;
}

export interface Preference {
  key: string;
  value: unknown;
  description?: string | null;
  updated_at: string;
}

export interface RetrieveRequest {
  query: string;
  kinds?: MemoryKind[];
  scope?: string;
  tags?: string[];
  topk?: number;
  vector_weight?: number;
  lexical_weight?: number;
}

export interface RetrieveResult {
  id: string;
  kind: MemoryKind;
  scope: string;
  content: string;
  tags: string[];
  score: number;
  vector_score: number;
  lexical_score: number;
  pinned: boolean;
  author_agent: string;
  created_at: string;
}

export interface Document {
  id: string;
  workspace_id: string;
  name: string;
  kind: string;
  byte_size: number;
  ingested_at?: string | null;
  created_at: string;
}

export interface Usage {
  workspace_id: string;
  memory_count: number;
  document_count: number;
  embed_tokens: number;
  retrieve_calls: number;
  updated_at?: string;
}
