-- Cloud chunks table — document-derived text chunks with embeddings.
--
-- Purpose: shared full-text + vector index for multi-device retrieval.
-- Local server's chunks table never crosses the wire; this is the
-- cloud-side authoritative version. One ingest run, every device
-- reads the same index.
--
-- Why separate from `memories`:
--   * memories = agent-curated facts/preferences (decision A)
--   * chunks   = mechanical splits of source documents (this table)
-- Mixing them muddied retrieval ranking and lifecycle policy in the
-- old system; we keep them apart by design.

CREATE TABLE IF NOT EXISTS chunks (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id  UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    document_id   UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    -- Logical grouping ('note', 'wiki:技术阅读', 'wiki:回传'). Mirrors
    -- the local 'dimension' field so retrieval can filter by topic.
    dimension     TEXT NOT NULL DEFAULT 'note',
    source_ref    TEXT NOT NULL DEFAULT '',  -- 'path#line_start-line_end' or similar
    line_start    INT NOT NULL DEFAULT 0,
    line_end      INT NOT NULL DEFAULT 0,
    text          TEXT NOT NULL,
    -- 384-dim matches the embed pod's default model
    -- (sentence-transformers/all-MiniLM-L6-v2). If the model changes
    -- we drop + re-ingest; ALTER COLUMN type doesn't preserve data.
    embedding     vector(384),
    keywords      JSONB NOT NULL DEFAULT '[]'::jsonb,
    content_hash  TEXT NOT NULL DEFAULT '',
    -- ingest_run_id ties chunks to a single ingest pass. When a doc
    -- is re-ingested we delete the old run's chunks so the index
    -- doesn't double up. Indexed for fast cleanup.
    ingest_run_id UUID,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_chunks_ws ON chunks(workspace_id, dimension, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chunks_doc ON chunks(document_id);
CREATE INDEX IF NOT EXISTS idx_chunks_run ON chunks(ingest_run_id);

-- pgvector ANN index. ivfflat with cosine; lists tuned later when
-- workspace data scales beyond ~10k chunks.
CREATE INDEX IF NOT EXISTS idx_chunks_embedding
    ON chunks USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 100);

-- FTS via Postgres tsvector — generated column so we never get out
-- of sync with `text`. 'simple' config keeps tokens raw (CJK + ascii
-- both work) without stemming away words like 'ingest' / 'ingests'.
ALTER TABLE chunks
    ADD COLUMN IF NOT EXISTS text_tsv tsvector
    GENERATED ALWAYS AS (to_tsvector('simple', coalesce(text, ''))) STORED;
CREATE INDEX IF NOT EXISTS idx_chunks_tsv ON chunks USING gin (text_tsv);

-- Ingest run audit trail. One row per "ingest this document" call.
-- Lets the desktop poll status, surface errors, and de-dupe rapid
-- re-ingest clicks.
CREATE TABLE IF NOT EXISTS ingest_runs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id    UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    document_id     UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    status          TEXT NOT NULL DEFAULT 'pending',  -- pending | running | done | failed
    chunk_count     INT NOT NULL DEFAULT 0,
    error           TEXT,
    started_at      TIMESTAMPTZ,
    finished_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ingest_runs_ws ON ingest_runs(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ingest_runs_doc ON ingest_runs(document_id, created_at DESC);
