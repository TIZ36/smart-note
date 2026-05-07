-- SmartNote local-mode schema (single-user, single-machine).
--
-- Mirrors the cloud Postgres schema 1:1 in shape so the local-impl
-- can return rows that look like cloud's CloudDocument / Memory /
-- Proposal / DocumentKn — UI components see the same TypeScript
-- types regardless of mode.
--
-- pgvector replaced by sqlite-vec virtual table (vec0).
-- jsonb replaced by TEXT columns containing JSON; reads use JSON.parse.

-- Documents (wiki + doc + note kinds).
CREATE TABLE IF NOT EXISTS documents (
  id          TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL DEFAULT 'local',
  kind        TEXT NOT NULL DEFAULT 'doc',  -- 'wiki_topic' | 'note' | 'doc'
  name        TEXT NOT NULL,
  content     TEXT NOT NULL DEFAULT '',
  byte_size   INTEGER NOT NULL DEFAULT 0,
  metadata    TEXT NOT NULL DEFAULT '{}',   -- JSON
  created_at  INTEGER NOT NULL,             -- ms epoch
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_documents_kind ON documents(kind, updated_at DESC);

-- Chunks: post-chunking unit, the row that gets embedded.
CREATE TABLE IF NOT EXISTS chunks (
  id          TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  ord         INTEGER NOT NULL,
  content     TEXT NOT NULL,
  line_start  INTEGER NOT NULL DEFAULT 0,
  line_end    INTEGER NOT NULL DEFAULT 0,
  -- the embedding lives in chunk_vec (sqlite-vec virtual table); this
  -- table just records the chunk's existence + line provenance
  has_embedding INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chunks_doc ON chunks(document_id, ord);

-- sqlite-vec virtual table — 1024-dim BGE-m3 (per user choice).
-- Loaded by db.mjs after `db.loadExtension(<sqlite-vec path>)`.
-- The rowid here = chunks.rowid for fast joins.
CREATE VIRTUAL TABLE IF NOT EXISTS chunk_vec USING vec0(
  embedding float[1024]
);

-- AI segment classification (ai_enrich output).
CREATE TABLE IF NOT EXISTS tag_segments (
  id          TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  line_start  INTEGER NOT NULL,
  line_end    INTEGER NOT NULL,
  tag         TEXT NOT NULL,
  confidence  REAL NOT NULL DEFAULT 0,
  summary     TEXT NOT NULL DEFAULT '',
  meta        TEXT NOT NULL DEFAULT '{}'    -- JSON: secondary_tags, topic_name, keywords, entities, is_credential
);
CREATE INDEX IF NOT EXISTS idx_tag_seg_doc ON tag_segments(document_id);

-- Wiki Phase B output (per-chapter abstract + keywords).
CREATE TABLE IF NOT EXISTS wiki_chapters (
  id          TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  ord         INTEGER NOT NULL,
  title       TEXT NOT NULL,
  line_start  INTEGER NOT NULL DEFAULT 0,
  line_end    INTEGER NOT NULL DEFAULT 0,
  summary     TEXT,
  summary_sha TEXT,                           -- canonical hash → skip re-summarize when content unchanged
  summarized  INTEGER NOT NULL DEFAULT 0,    -- 0/1
  keywords    TEXT NOT NULL DEFAULT '[]',    -- JSON array of strings
  entities    TEXT NOT NULL DEFAULT '[]',    -- JSON array
  last_error  TEXT
);
CREATE INDEX IF NOT EXISTS idx_chapters_doc ON wiki_chapters(document_id, ord);

-- Workspace tag dictionary (the closed enum that ai_enrich /
-- note_classify pick from).
CREATE TABLE IF NOT EXISTS workspace_tags (
  name        TEXT PRIMARY KEY,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  description TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL
);

-- Memories (proposals + accepted live in same table, keyed by
-- status field — matches cloud's design).
-- status: 'draft' (=pending proposal) | 'active' (=accepted) |
--         'archived' (=rejected).
CREATE TABLE IF NOT EXISTS memories (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL,            -- preference|fact|procedure|episode|document_ref
  scope           TEXT NOT NULL DEFAULT 'global',
  content         TEXT NOT NULL,
  structured      TEXT NOT NULL DEFAULT '{}',  -- JSON
  tags            TEXT NOT NULL DEFAULT '[]',  -- JSON array
  source_refs     TEXT NOT NULL DEFAULT '[]',
  confidence      REAL NOT NULL DEFAULT 1.0,
  pinned          INTEGER NOT NULL DEFAULT 0,
  supersedes      TEXT,
  status          TEXT NOT NULL DEFAULT 'active', -- draft|active|archived
  author_agent    TEXT,
  proposal_reason TEXT,
  reviewed_by     TEXT,
  reviewed_at     INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memories_status ON memories(status, created_at DESC);

-- Notes' AI tag suggestions (note_classify output).
CREATE TABLE IF NOT EXISTS note_tag_suggestions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  run_id      TEXT,
  tag         TEXT NOT NULL,
  confidence  REAL NOT NULL DEFAULT 0,
  reasoning   TEXT,
  status      TEXT NOT NULL DEFAULT 'pending', -- pending|accepted|dismissed
  proposed_at INTEGER NOT NULL,
  reviewed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_note_sugg_doc ON note_tag_suggestions(document_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_note_sugg_pending
  ON note_tag_suggestions(document_id, tag)
  WHERE status='pending';

-- Run ledger (mirrors cloud's processing_runs).
CREATE TABLE IF NOT EXISTS processing_runs (
  id           TEXT PRIMARY KEY,                -- UUID
  document_id  TEXT REFERENCES documents(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,                   -- chunk_embed | ai_enrich | wiki_abstract | note_classify
  status       TEXT NOT NULL,                   -- queued | running | done | failed | partial | skipped
  executor     TEXT NOT NULL DEFAULT 'inline',
  result       TEXT,                            -- JSON
  error        TEXT,
  revision     INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  started_at   INTEGER,
  finished_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_runs_doc_kind ON processing_runs(document_id, kind, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_recent ON processing_runs(created_at DESC);

-- Pipeline events (the durable event stream — backs the in-app
-- Logs channel). Matches cloud's pipeline_events shape.
CREATE TABLE IF NOT EXISTS pipeline_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id       TEXT,
  document_id  TEXT,
  stage        TEXT,
  event        TEXT NOT NULL,
  status       TEXT,
  message      TEXT,
  error        TEXT,
  schema_version INTEGER NOT NULL DEFAULT 1,
  data         TEXT NOT NULL DEFAULT '{}',     -- JSON
  at           INTEGER NOT NULL                 -- ms epoch
);
CREATE INDEX IF NOT EXISTS idx_pe_run ON pipeline_events(run_id, at);
CREATE INDEX IF NOT EXISTS idx_pe_at ON pipeline_events(at DESC);
CREATE INDEX IF NOT EXISTS idx_pe_filter ON pipeline_events(stage, status, at DESC);

-- Schema version pin so future migrations can detect.
CREATE TABLE IF NOT EXISTS _schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT OR IGNORE INTO _schema_meta(key, value) VALUES ('version', '1');
INSERT OR IGNORE INTO _schema_meta(key, value) VALUES ('embed_dim', '1024');
INSERT OR IGNORE INTO _schema_meta(key, value) VALUES ('embed_model', 'bge-m3');
