-- v3.6 — note_classify output. Distinct from tag_segments.
--
-- The Notes surface in Library treats tags as user-authored: the LLM
-- proposes (subset of workspace_tags), the user accepts or dismisses.
-- AI never directly writes the applied tag set on a note. So we land
-- the LLM output here, and a separate accept step copies the chosen
-- tag onto the note via document metadata.
--
-- Compare/contrast:
--   ai_enrich  → tag_segments  → tags applied directly to chunks
--   note_classify → note_tag_suggestions → user reviews, then accepts

CREATE TABLE IF NOT EXISTS note_tag_suggestions (
  id           BIGSERIAL PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  document_id  UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  run_id       UUID,                         -- references processing_runs(id); the classify run that emitted this
  tag          TEXT NOT NULL,                -- must exist in workspace_tags at write time
  confidence   REAL NOT NULL DEFAULT 0.0,
  reasoning    TEXT,                         -- short LLM justification (optional)
  status       TEXT NOT NULL DEFAULT 'pending',  -- pending | accepted | dismissed
  proposed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at  TIMESTAMPTZ
);

-- One suggestion per (doc, tag, run). A new run for the same tag
-- inserts a fresh row, so the user can see the AI's confidence
-- evolve across re-classifications.
CREATE INDEX IF NOT EXISTS note_sugg_doc
  ON note_tag_suggestions(document_id, status, proposed_at DESC);

CREATE INDEX IF NOT EXISTS note_sugg_run
  ON note_tag_suggestions(run_id);

-- Active set per (workspace, doc): only one pending suggestion per
-- (doc, tag). Lets POST .../classify dedupe — re-running on the same
-- content shouldn't churn duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS note_sugg_pending_unique
  ON note_tag_suggestions(workspace_id, document_id, tag)
  WHERE status = 'pending';
