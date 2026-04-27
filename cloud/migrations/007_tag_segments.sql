-- SmartNote Cloud — tag_segments (cloud port of server/app schema).
--
-- One row per (document, line-range) classification result. The
-- classifier returns segments shaped like {start_line, end_line, tag,
-- confidence, summary}; we land them here so that retrieval can join
-- against tags and the desktop can render the same per-line chips.
--
-- We don't denormalize tag onto memories (memories already have a
-- `tags` array); tag_segments is the source of truth for *where in
-- the doc* a tag came from.

CREATE TABLE IF NOT EXISTS tag_segments (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  document_id  UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  start_line   INTEGER NOT NULL,
  end_line     INTEGER NOT NULL,
  tag          TEXT NOT NULL,
  confidence   REAL NOT NULL DEFAULT 0.0,
  summary      TEXT NOT NULL DEFAULT '',
  meta         JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tag_segments_doc
  ON tag_segments(document_id, start_line);
CREATE INDEX IF NOT EXISTS idx_tag_segments_ws_tag
  ON tag_segments(workspace_id, tag);
