-- SmartNote Cloud — documents table.
-- Separate from memories because docs are often large-text blobs and we
-- want to keep the memories row compact. A `document_ref` memory row
-- points at a document via `structured->>'document_id'`; retrieval can
-- surface the tag ("this came from doc X") without pulling doc bytes
-- into every response.

CREATE TABLE IF NOT EXISTS documents (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'text',     -- text | markdown | url | pdf | html
  content       TEXT NOT NULL,
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
  byte_size     INTEGER NOT NULL DEFAULT 0,
  ingested_at   TIMESTAMPTZ,                      -- NULL until the ingest job finishes
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_documents_ws ON documents(workspace_id, created_at DESC);
