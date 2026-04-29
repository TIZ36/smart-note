-- v1.2 Phase 0 / P0-3 — wiki chapter table + entity_links extension
-- + workspace billing toggle.
--
-- See docs/processing-pipeline.md §2.4 and §6.4.

-- ── wiki_chapters ──────────────────────────────────────────────
-- One row per H2 (and the implicit "preamble" before the first H2)
-- of a smartnote_type='wiki_topic' document. Phase A populates
-- structural fields (ord, anchor, title, line_range); Phase B fills
-- summary / keywords. Entities are NOT stored as a UUID[] here —
-- single source of truth is `entity_links` rows with
-- source_kind='wiki_chapter'.

CREATE TABLE IF NOT EXISTS wiki_chapters (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID NOT NULL,
  document_id   UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  ord           INT NOT NULL,           -- 0-based position within doc
  level         INT NOT NULL,           -- always 2 in v1.2 (H2-only)
  anchor        TEXT NOT NULL,          -- slugified heading
  title         TEXT NOT NULL,
  line_start    INT NOT NULL,
  line_end      INT NOT NULL,

  -- Phase B fields, NULL until ai_enrich on this chapter completes.
  summary       TEXT,
  keywords      JSONB,

  -- sha of canonicalize(chapter_text). Phase B skips chapters whose
  -- summary_sha hasn't changed since the last successful run.
  summary_sha   TEXT,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS wiki_chapters_doc_ord
  ON wiki_chapters(document_id, ord);
CREATE INDEX IF NOT EXISTS wiki_chapters_anchor
  ON wiki_chapters(document_id, anchor);


-- ── entity_links extension ─────────────────────────────────────
-- Adds a discriminator so wiki-chapter mentions and note-segment
-- mentions live in the same table without ambiguity. Existing rows
-- are implicitly note-segment mentions; backfill labels them.

ALTER TABLE entity_links
  ADD COLUMN IF NOT EXISTS source_kind TEXT;

UPDATE entity_links SET source_kind = 'note_segment'
  WHERE source_kind IS NULL;

-- After backfill, future writes must specify source_kind. NOT NULL
-- can't be applied retroactively without a quick UPDATE first; the
-- two statements together (UPDATE then NOT NULL) are safe because
-- the runner executes them in one connection.
ALTER TABLE entity_links
  ALTER COLUMN source_kind SET NOT NULL;

CREATE INDEX IF NOT EXISTS entity_links_source_kind
  ON entity_links(workspace_id, source_kind);


-- ── workspaces.legacy_billing_enforcement ──────────────────────
-- Per-workspace toggle replacing the rejected 30-day grandfather
-- mechanism. TRUE (default) means `force=true` and auto-mode toggle
-- writes require the `billing` scope. Owner can opt out via Cloud
-- Console settings; flip writes an audit log entry (handled in the
-- application layer, not this migration).

ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS legacy_billing_enforcement BOOLEAN
    NOT NULL DEFAULT TRUE;
