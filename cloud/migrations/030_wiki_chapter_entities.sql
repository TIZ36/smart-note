-- v1.2 — surface per-chapter entities on wiki_chapters so
-- graph_topology can compute shared-entity links involving wiki docs.
--
-- Why: topology iterates entities-by-document. Notes have a clean
-- index via tag_segments.meta.entities (which IS keyed by document_id).
-- Wikis previously dropped entities only into the workspace-level
-- entities + entity_links tables with no per-document backreference,
-- so topology saw 0 entities for any wiki doc → 0 cross-doc links
-- whenever either side was a wiki. Storing the entities directly on
-- wiki_chapters mirrors the note pattern: a document-attached jsonb
-- array of {name, type} that topology can union.

ALTER TABLE wiki_chapters
  ADD COLUMN IF NOT EXISTS entities JSONB NOT NULL DEFAULT '[]'::jsonb;

-- No backfill — re-running wiki_abstract on the affected docs
-- repopulates this column. Topology gracefully treats `[]` as
-- "no entities yet" so old docs that haven't been re-enriched
-- simply contribute zero candidates instead of breaking.
