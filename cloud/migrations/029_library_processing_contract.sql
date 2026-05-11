-- v3.7 — Library client integration contract.
-- Adds the final processing kind names and document topology artefacts
-- required by docs/library-client-integration.md.

CREATE TABLE IF NOT EXISTS document_links (
  workspace_id        UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_document_id  UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  target_document_id  UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  relation_type       TEXT NOT NULL,
  score               NUMERIC(4,3) NOT NULL,
  evidence            JSONB NOT NULL DEFAULT '{}'::jsonb,
  run_id              UUID,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source_document_id, target_document_id, relation_type),
  CONSTRAINT document_links_no_self CHECK (source_document_id <> target_document_id)
);

CREATE INDEX IF NOT EXISTS document_links_source_score
  ON document_links(source_document_id, score DESC);

CREATE INDEX IF NOT EXISTS document_links_ws
  ON document_links(workspace_id, created_at DESC);

-- Existing installs may have rows using the legacy ai_enrich name.
UPDATE processing_runs SET kind = 'chunk_enrich' WHERE kind = 'ai_enrich';
UPDATE pipeline_events SET stage = 'chunk_enrich' WHERE stage = 'ai_enrich';
