-- v1.2 Phase 0 / P0-2 — chunk-level dedup primitives.
--
-- See docs/processing-pipeline.md §2.2.
--
-- Two new tables (`chunk_blobs`, `chunk_refs`) plus a `chunks_v` view
-- that mirrors the legacy `chunks` shape so existing search code can
-- swap `FROM chunks` → `FROM chunks_v` in P1-4 without restructuring.
--
-- The legacy `chunks` table is NOT touched — it survives through the
-- dual-write phase (P1) and the soak window (post-P4). P5 drops it.
--
-- Embedding column is fixed-dim VECTOR(384) matching the production
-- embedder (sentence-transformers/all-MiniLM-L6-v2). pgvector's HNSW
-- index requires a known dimension at index-build time; `VECTOR`
-- without a size cannot back HNSW. Multi-embedder support, when
-- needed, ships as table partitions (chunk_blobs_384, chunk_blobs_1024)
-- routed by model name — explicitly out of scope for v1.2.

CREATE TABLE IF NOT EXISTS chunk_blobs (
  workspace_id     UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  content_sha      TEXT NOT NULL,            -- sha256 of canonicalize(text)
  text             TEXT NOT NULL,
  embedding        VECTOR(384),              -- nullable until embed call returns
  embedding_model  TEXT NOT NULL,            -- e.g. 'all-MiniLM-L6-v2'
  keywords         JSONB NOT NULL DEFAULT '[]'::jsonb,
  fts              TSVECTOR
                   GENERATED ALWAYS AS (to_tsvector('simple', text)) STORED,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, content_sha)
);

-- HNSW cannot contain NULL embeddings; partial index keeps it
-- consistent during the INSERT-then-UPDATE-with-vector window the
-- pipeline uses (insert blob row to claim the sha, then run the embed
-- call, then UPDATE the embedding).
CREATE INDEX IF NOT EXISTS chunk_blobs_emb
  ON chunk_blobs USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL;

CREATE INDEX IF NOT EXISTS chunk_blobs_fts
  ON chunk_blobs USING gin (fts);

CREATE TABLE IF NOT EXISTS chunk_refs (
  id            BIGSERIAL PRIMARY KEY,
  workspace_id  UUID NOT NULL,
  document_id   UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  chunk_sha     TEXT NOT NULL,
  line_start    INT NOT NULL,
  line_end      INT NOT NULL,
  ord           INT NOT NULL,             -- position within doc, 0-based
  ingest_run_id UUID NOT NULL,
  -- Denormalized from documents.metadata->>'smartnote_type' (or
  -- 'wiki:<topic>' for wiki_topic kind). Lives here, not on
  -- chunk_blobs, because the same blob could in principle be
  -- referenced by docs of different dimensions; the ref is the
  -- per-doc-per-position record so dimension belongs with it.
  -- NOT NULL: writers MUST compute it (pipeline.py already does).
  dimension     TEXT NOT NULL,
  FOREIGN KEY (workspace_id, chunk_sha)
    REFERENCES chunk_blobs(workspace_id, content_sha)
);
CREATE INDEX IF NOT EXISTS chunk_refs_doc
  ON chunk_refs(document_id, ord);
CREATE INDEX IF NOT EXISTS chunk_refs_blob
  ON chunk_refs(workspace_id, chunk_sha);
CREATE INDEX IF NOT EXISTS chunk_refs_ws_dim
  ON chunk_refs(workspace_id, dimension);

-- Critical for race-safe backfill + dual-write: lets both the live
-- writer and the backfill script use INSERT ... ON CONFLICT DO NOTHING
-- without producing duplicate refs for the same (doc, ord). Without
-- this index, two concurrent inserts for the same logical position
-- both succeed.
CREATE UNIQUE INDEX IF NOT EXISTS chunk_refs_doc_ord
  ON chunk_refs(document_id, ord);

-- Read view that retrieval code can target instead of chunk_refs +
-- chunk_blobs join boilerplate. Replaces `FROM chunks` in P1-4.
-- `source_ref` is synthesized to match the legacy column shape so
-- callers don't need to translate.
CREATE OR REPLACE VIEW chunks_v AS
  SELECT
    cr.id              AS id,
    cr.workspace_id    AS workspace_id,
    cr.document_id     AS document_id,
    cr.line_start      AS line_start,
    cr.line_end        AS line_end,
    cr.ord             AS ord,
    cr.ingest_run_id   AS ingest_run_id,
    cr.dimension       AS dimension,
    'doc:' || cr.document_id::text
            || '#' || cr.line_start::text
            || '-' || cr.line_end::text
                       AS source_ref,
    cb.text            AS text,
    cb.embedding       AS embedding,
    cb.embedding_model AS embedding_model,
    cb.keywords        AS keywords,
    cb.fts             AS fts
  FROM chunk_refs cr
  INNER JOIN chunk_blobs cb
    ON cb.workspace_id = cr.workspace_id
   AND cb.content_sha  = cr.chunk_sha;
