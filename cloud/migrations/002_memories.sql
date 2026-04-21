-- SmartNote Cloud — unified memories table.
-- One row per memory regardless of kind (fact / preference / procedure /
-- episode / document_ref). The API exposes kind-specific sugar endpoints
-- (e.g. /v1/preferences) that are just filtered views over this table.

CREATE TABLE IF NOT EXISTS memories (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  author_agent  TEXT NOT NULL,
  kind          TEXT NOT NULL,            -- fact | preference | procedure | episode | document_ref
  scope         TEXT NOT NULL DEFAULT 'global',
  content       TEXT NOT NULL,
  structured    JSONB,                    -- key/value for preferences, step list for procedures, …
  embedding     VECTOR(384),              -- sized for all-MiniLM-L6-v2; swap model → full re-embed
  confidence    REAL NOT NULL DEFAULT 1.0,
  pinned        BOOLEAN NOT NULL DEFAULT false,
  supersedes    UUID REFERENCES memories(id),
  source_refs   JSONB NOT NULL DEFAULT '[]'::jsonb,
  tags          TEXT[] NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_memories_ws_kind ON memories(workspace_id, kind, scope);
CREATE INDEX IF NOT EXISTS idx_memories_ws_created ON memories(workspace_id, created_at DESC);
-- ivfflat requires ANALYZE after bulk loads; pick `lists` heuristically as
-- sqrt(N) / 2 once data arrives. At MVP scale (few thousand rows) the
-- default 100 is fine and we can tune later.
CREATE INDEX IF NOT EXISTS idx_memories_embedding
  ON memories USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);
