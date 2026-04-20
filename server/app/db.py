import os
import sqlite3

from app.config import settings


SCHEMA = """
PRAGMA journal_mode=WAL;

CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  build_id TEXT NOT NULL DEFAULT '',
  source_file TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  text TEXT NOT NULL,
  text_segmented TEXT NOT NULL DEFAULT '',
  dimension TEXT NOT NULL,
  project_slug TEXT,
  embedding_json TEXT,
  keywords_json TEXT NOT NULL DEFAULT '[]',
  entities_json TEXT NOT NULL DEFAULT '[]',
  ai_summary TEXT NOT NULL DEFAULT '',
  content_hash TEXT NOT NULL DEFAULT '',
  note_ts TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_chunks_dimension ON chunks(dimension);
CREATE INDEX IF NOT EXISTS idx_chunks_project_slug ON chunks(project_slug);
CREATE INDEX IF NOT EXISTS idx_chunks_note_ts ON chunks(note_ts);

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  text_segmented,
  content='chunks',
  content_rowid='id'
);

CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, text_segmented) VALUES (new.id, new.text_segmented);
END;

CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text_segmented) VALUES('delete', old.id, old.text_segmented);
END;

CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text_segmented) VALUES('delete', old.id, old.text_segmented);
  INSERT INTO chunks_fts(rowid, text_segmented) VALUES (new.id, new.text_segmented);
END;

CREATE TABLE IF NOT EXISTS query_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  query_text TEXT NOT NULL,
  retrieval_mode TEXT NOT NULL,
  topk INTEGER NOT NULL,
  latency_ms INTEGER NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS answer_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  query_id INTEGER NOT NULL,
  answer_text TEXT NOT NULL,
  evidence_refs TEXT NOT NULL,
  model_name TEXT NOT NULL,
  latency_ms INTEGER NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS feedback_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  answer_id INTEGER NOT NULL,
  feedback_type TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_key TEXT NOT NULL,
  memory_text TEXT NOT NULL,
  source_answer_ids TEXT NOT NULL,
  quality_score REAL NOT NULL DEFAULT 0,
  used_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS search_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  query_text TEXT NOT NULL,
  result_count INTEGER NOT NULL DEFAULT 0,
  tag_filter TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS entities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  entity_type TEXT NOT NULL,
  mention_count INTEGER NOT NULL DEFAULT 1,
  first_seen TEXT DEFAULT CURRENT_TIMESTAMP,
  last_seen TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS entity_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_entity_id INTEGER NOT NULL,
  target_entity_id INTEGER NOT NULL,
  relation TEXT NOT NULL DEFAULT 'co-occurs',
  weight INTEGER NOT NULL DEFAULT 1,
  UNIQUE(source_entity_id, target_entity_id, relation)
);

CREATE TABLE IF NOT EXISTS query_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  query_text TEXT NOT NULL,
  query_embedding_json TEXT,
  effective_weights_json TEXT NOT NULL,
  evidence_ids_json TEXT NOT NULL,
  rerank_order_json TEXT,
  feedback_score REAL NOT NULL DEFAULT 0,
  hit_count INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS builds (
  id TEXT PRIMARY KEY,
  source_file TEXT NOT NULL,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  segment_count INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 0,
  token_usage_json TEXT NOT NULL DEFAULT '{}',
  estimated_cost_cny REAL NOT NULL DEFAULT 0,
  tags_json TEXT NOT NULL DEFAULT '{}',
  tags_config_json TEXT NOT NULL DEFAULT '[]',
  enrich_status TEXT NOT NULL DEFAULT 'completed',
  completed_by TEXT NOT NULL DEFAULT '',
  awaiting_since TEXT,
  ingest_kind TEXT NOT NULL DEFAULT 'full',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS pending_format_docs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  format_id TEXT NOT NULL UNIQUE,
  topic_name TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  raw_content TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT '',
  target_dir TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'awaiting',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_pending_format_status ON pending_format_docs(status);

CREATE TABLE IF NOT EXISTS tag_segments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  build_id TEXT NOT NULL DEFAULT '',
  source_file TEXT NOT NULL,
  tag TEXT NOT NULL,
  topic_name TEXT NOT NULL DEFAULT '',
  line_start INTEGER NOT NULL,
  line_end INTEGER NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  keywords_json TEXT NOT NULL DEFAULT '[]',
  entities_json TEXT NOT NULL DEFAULT '[]',
  is_credential INTEGER NOT NULL DEFAULT 0,
  centroid_json TEXT NOT NULL DEFAULT '',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS search_misses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  query_text TEXT NOT NULL,
  query_embedding_json TEXT,
  result_count INTEGER NOT NULL DEFAULT 0,
  top_score REAL NOT NULL DEFAULT 0,
  tag_filter TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_search_misses_created ON search_misses(created_at);

CREATE TABLE IF NOT EXISTS meta_memory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL DEFAULT 'rule',
  text TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'global',
  hit_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS answer_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  signature TEXT NOT NULL UNIQUE,
  query_text TEXT NOT NULL,
  evidence_ids_json TEXT NOT NULL,
  answer_text TEXT NOT NULL,
  model_name TEXT,
  trust_floor REAL NOT NULL DEFAULT 0,
  hit_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_answer_cache_sig ON answer_cache(signature);

CREATE TABLE IF NOT EXISTS conflict_pending (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  build_id TEXT NOT NULL,
  source_file TEXT NOT NULL,
  line_start INTEGER NOT NULL,
  line_end INTEGER NOT NULL,
  existing_tag TEXT,
  existing_topic TEXT,
  incoming_tag TEXT,
  incoming_topic TEXT,
  incoming_summary TEXT,
  incoming_payload_json TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ocr_pending (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_file TEXT NOT NULL,
  line_no INTEGER NOT NULL,
  image_ref TEXT NOT NULL,
  extracted_text TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  processed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_tag_segments_build ON tag_segments(build_id);
CREATE INDEX IF NOT EXISTS idx_tag_segments_tag ON tag_segments(tag);
CREATE INDEX IF NOT EXISTS idx_tag_segments_file ON tag_segments(source_file);

CREATE TABLE IF NOT EXISTS qa_memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  query_text TEXT NOT NULL,
  query_embedding_json TEXT,
  answer_text TEXT NOT NULL,
  evidence_ids_json TEXT NOT NULL DEFAULT '[]',
  weights_json TEXT NOT NULL DEFAULT '{}',
  feedback_score REAL NOT NULL DEFAULT 1.0,
  used_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS rewrite_candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_file TEXT NOT NULL,
  candidate_path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'validating',
  validation_start TEXT DEFAULT CURRENT_TIMESTAMP,
  validation_days INTEGER NOT NULL DEFAULT 7,
  total_queries INTEGER NOT NULL DEFAULT 0,
  old_wins INTEGER NOT NULL DEFAULT 0,
  candidate_wins INTEGER NOT NULL DEFAULT 0,
  ties INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS rewrite_validations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id INTEGER NOT NULL,
  query_text TEXT NOT NULL,
  old_top5_score REAL NOT NULL,
  candidate_top5_score REAL NOT NULL,
  winner TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Skills = reusable recipes abstracted from note patterns. Notes record the
-- skill; any MCP client (Claude Code, Cursor, OpenCode) reads them and
-- executes themselves. SmartNote stores the recipe + time-sliced context.
-- kind: 'periodic' (time-cycle ritual) | 'sequence' (ordered stages)
-- period_hint: 'daily' | 'weekly' | 'monthly' | 'ad_hoc'
-- nodes_json: ordered list of {name, description, trigger_hints[], expected_tag}
DROP TABLE IF EXISTS workflow_runs;
DROP TABLE IF EXISTS workflow_templates;

CREATE TABLE IF NOT EXISTS skill_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'periodic',
  period_hint TEXT NOT NULL DEFAULT 'weekly',
  nodes_json TEXT NOT NULL DEFAULT '[]',
  source_segment_ids TEXT NOT NULL DEFAULT '[]',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- One run = a user-triggered invocation. Client creates a pending run; the
-- MCP caller (Claude) picks it up, executes, and records the result.
-- status: 'pending_exec' | 'completed' | 'skipped'
-- steps_json: per-node result [{name, status, evidence_chunk_ids, notes}]
CREATE TABLE IF NOT EXISTS skill_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  template_id INTEGER NOT NULL,
  slice_start_ts TEXT NOT NULL,
  slice_end_ts TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_exec',
  result_summary TEXT NOT NULL DEFAULT '',
  steps_json TEXT NOT NULL DEFAULT '[]',
  triggered_by TEXT NOT NULL DEFAULT 'ui',
  started_at TEXT DEFAULT CURRENT_TIMESTAMP,
  finished_at TEXT,
  FOREIGN KEY (template_id) REFERENCES skill_templates(id)
);

CREATE INDEX IF NOT EXISTS idx_skill_runs_tpl ON skill_runs(template_id);
CREATE INDEX IF NOT EXISTS idx_skill_runs_status ON skill_runs(status);

-- Accumulated ingest packs — each user save (or external edit detection)
-- creates one pack representing what changed since the last ingest. Packs
-- are then applied (triggering actual re-ingest) on the user's schedule.
--
-- kind: 'in_app'   — save from the SmartNote editor or MCP append
--       'external' — file changed outside SmartNote (md5 mismatch on load)
-- status: 'pending'   — counted in the bottom-right badge
--         'applied'   — the triggered ingest completed
--         'discarded' — user hid it without applying
--         'merged'    — collapsed into another pack
CREATE TABLE IF NOT EXISTS ingest_packs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  raw_path TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'in_app',
  diff_patch TEXT NOT NULL DEFAULT '',
  before_md5 TEXT NOT NULL DEFAULT '',
  after_md5 TEXT NOT NULL DEFAULT '',
  lines_added INTEGER NOT NULL DEFAULT 0,
  lines_removed INTEGER NOT NULL DEFAULT 0,
  byte_delta INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  merged_into INTEGER,
  applied_build_id TEXT,
  -- Structured per-change list for UI. Each entry: {op, line, range, chars,
  -- chars_added, chars_removed, preview}. Stored alongside diff_patch so the
  -- UI can show "which line changed and how much" without parsing unified diff.
  changes_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  applied_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_ingest_packs_path ON ingest_packs(raw_path, status);
CREATE INDEX IF NOT EXISTS idx_ingest_packs_status ON ingest_packs(status);

-- Per-line note metadata. Keyed by (file_path, line_hash) so marks survive
-- line-number shifts when the user inserts/deletes above. `line_no_last`
-- is the last-observed 1-based line number (updated on save); the UI uses
-- it for rendering, but the hash is the authoritative key.
--
-- ts: user-visible write time for the line (set on first-seen save, stable
-- afterward as long as content doesn't change)
-- bookmark: non-empty label → bookmarked
-- highlight_color: non-empty → highlighted with that color
CREATE TABLE IF NOT EXISTS note_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_path TEXT NOT NULL,
  line_hash TEXT NOT NULL,
  line_no_last INTEGER NOT NULL DEFAULT 0,
  line_preview TEXT NOT NULL DEFAULT '',
  ts TEXT,
  bookmark TEXT NOT NULL DEFAULT '',
  highlight_color TEXT NOT NULL DEFAULT '',
  highlight_note TEXT NOT NULL DEFAULT '',
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(file_path, line_hash)
);

CREATE INDEX IF NOT EXISTS idx_note_lines_path ON note_lines(file_path);
CREATE INDEX IF NOT EXISTS idx_note_lines_bookmark ON note_lines(file_path, bookmark)
  WHERE bookmark != '';

-- Persisted file state for external-edit detection. Updated after each
-- successful save or apply. On load, compare the on-disk md5 to the stored
-- md5 to decide whether the file changed externally.
CREATE TABLE IF NOT EXISTS note_file_state (
  file_path TEXT PRIMARY KEY,
  md5 TEXT NOT NULL,
  mtime REAL,
  last_build_id TEXT,
  line_count INTEGER NOT NULL DEFAULT 0,
  byte_size INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Runtime-editable app settings. Seeded from env on first launch, mutated by
-- the Settings UI via POST /settings — changes take effect on the running
-- backend without a restart (the Settings singleton is refreshed in place).
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS smart_tables (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS smart_table_sheets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  table_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  ord INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(table_id, name),
  FOREIGN KEY (table_id) REFERENCES smart_tables(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS smart_table_columns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sheet_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('text', 'link', 'image')),
  ord INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(sheet_id, name),
  FOREIGN KEY (sheet_id) REFERENCES smart_table_sheets(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS smart_table_rows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sheet_id INTEGER NOT NULL,
  ord INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (sheet_id) REFERENCES smart_table_sheets(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS smart_table_cells (
  row_id INTEGER NOT NULL,
  column_id INTEGER NOT NULL,
  value_json TEXT NOT NULL,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (row_id, column_id),
  FOREIGN KEY (row_id) REFERENCES smart_table_rows(id) ON DELETE CASCADE,
  FOREIGN KEY (column_id) REFERENCES smart_table_columns(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS smart_table_cell_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  row_id INTEGER NOT NULL,
  column_id INTEGER NOT NULL,
  old_value TEXT,
  new_value TEXT,
  changed_at TEXT DEFAULT CURRENT_TIMESTAMP,
  source TEXT NOT NULL DEFAULT 'ui',
  FOREIGN KEY (row_id) REFERENCES smart_table_rows(id) ON DELETE CASCADE,
  FOREIGN KEY (column_id) REFERENCES smart_table_columns(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_smart_table_sheets_table_id
  ON smart_table_sheets(table_id);

CREATE INDEX IF NOT EXISTS idx_smart_table_columns_sheet_id
  ON smart_table_columns(sheet_id);

CREATE INDEX IF NOT EXISTS idx_smart_table_rows_sheet_id
  ON smart_table_rows(sheet_id);

CREATE INDEX IF NOT EXISTS idx_smart_table_cell_history_row_column
  ON smart_table_cell_history(row_id, column_id);
"""

MIGRATE_SQL = """
-- Add new columns if they don't exist (safe to run multiple times)
-- SQLite doesn't support IF NOT EXISTS for ALTER TABLE, so we use pragmas

PRAGMA table_info(chunks);
"""


def connect() -> sqlite3.Connection:
    os.makedirs(os.path.dirname(settings.db_path), exist_ok=True)
    conn = sqlite3.connect(settings.db_path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db() -> None:
    with connect() as conn:
        conn.executescript(SCHEMA)
        conn.commit()


def migrate_db() -> None:
    """Add new columns to existing databases without data loss."""
    with connect() as conn:
        # Ensure any newly added tables (all CREATE TABLE IF NOT EXISTS) are
        # created on existing databases.
        conn.executescript(SCHEMA)
        # Check existing columns
        columns = {
            row[1] for row in conn.execute("PRAGMA table_info(chunks)").fetchall()
        }
        new_cols = {
            "build_id": "TEXT NOT NULL DEFAULT ''",
            "text_segmented": "TEXT NOT NULL DEFAULT ''",
            "keywords_json": "TEXT NOT NULL DEFAULT '[]'",
            "entities_json": "TEXT NOT NULL DEFAULT '[]'",
            "ai_summary": "TEXT NOT NULL DEFAULT ''",
            "content_hash": "TEXT NOT NULL DEFAULT ''",
            "trust_score": "REAL NOT NULL DEFAULT 0",
            "embedding_q8": "BLOB",  # int8-quantized embedding + scale (B3)
            "embedding_scale": "REAL NOT NULL DEFAULT 0",
            "note_ts": "TEXT",  # user write time (distinct from created_at = ingest time)
        }
        for col, typedef in new_cols.items():
            if col not in columns:
                conn.execute(f"ALTER TABLE chunks ADD COLUMN {col} {typedef}")

        # Add changes_json to ingest_packs for structured per-line change UI.
        pack_cols = {
            row[1] for row in conn.execute("PRAGMA table_info(ingest_packs)").fetchall()
        }
        if pack_cols and "changes_json" not in pack_cols:
            conn.execute(
                "ALTER TABLE ingest_packs ADD COLUMN changes_json "
                "TEXT NOT NULL DEFAULT '[]'"
            )

        if "note_ts" not in columns:
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_chunks_note_ts ON chunks(note_ts)"
            )
            # Backfill note_ts from created_at for existing chunks so time
            # slicing works uniformly. Future writes will supply their own.
            conn.execute(
                "UPDATE chunks SET note_ts = created_at "
                "WHERE note_ts IS NULL AND created_at IS NOT NULL"
            )

        # Backfill content_hash for pre-existing chunks so incremental edit
        # detection has a baseline instead of treating every chunk as changed.
        if "content_hash" not in columns:
            import hashlib as _hl

            stale = conn.execute(
                "SELECT id, text FROM chunks WHERE content_hash = ''"
            ).fetchall()
            for r in stale:
                h = _hl.sha256((r["text"] or "").encode("utf-8")).hexdigest()[:16]
                conn.execute(
                    "UPDATE chunks SET content_hash = ? WHERE id = ?", (h, r["id"])
                )

        # Check if entities table exists
        tables = {
            row[0]
            for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ).fetchall()
        }
        if "entities" not in tables:
            conn.executescript(
                """
                CREATE TABLE entities (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  name TEXT NOT NULL UNIQUE,
                  entity_type TEXT NOT NULL,
                  mention_count INTEGER NOT NULL DEFAULT 1,
                  first_seen TEXT DEFAULT CURRENT_TIMESTAMP,
                  last_seen TEXT DEFAULT CURRENT_TIMESTAMP
                );
                CREATE TABLE IF NOT EXISTS entity_links (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  source_entity_id INTEGER NOT NULL,
                  target_entity_id INTEGER NOT NULL,
                  relation TEXT NOT NULL DEFAULT 'co-occurs',
                  weight INTEGER NOT NULL DEFAULT 1,
                  UNIQUE(source_entity_id, target_entity_id, relation)
                );
                """
            )

        if "query_profiles" not in tables:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS query_profiles (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  query_text TEXT NOT NULL,
                  query_embedding_json TEXT,
                  effective_weights_json TEXT NOT NULL,
                  evidence_ids_json TEXT NOT NULL,
                  rerank_order_json TEXT,
                  feedback_score REAL NOT NULL DEFAULT 0,
                  hit_count INTEGER NOT NULL DEFAULT 1,
                  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
                )
                """
            )

        if "builds" not in tables:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS builds (
                  id TEXT PRIMARY KEY,
                  source_file TEXT NOT NULL,
                  chunk_count INTEGER NOT NULL DEFAULT 0,
                  segment_count INTEGER NOT NULL DEFAULT 0,
                  is_active INTEGER NOT NULL DEFAULT 0,
                  token_usage_json TEXT NOT NULL DEFAULT '{}',
                  estimated_cost_cny REAL NOT NULL DEFAULT 0,
                  tags_json TEXT NOT NULL DEFAULT '{}',
                  tags_config_json TEXT NOT NULL DEFAULT '[]',
                  created_at TEXT DEFAULT CURRENT_TIMESTAMP
                )
                """
            )
        else:
            b_cols = {
                r[1] for r in conn.execute("PRAGMA table_info(builds)").fetchall()
            }
            if "tags_config_json" not in b_cols:
                conn.execute(
                    "ALTER TABLE builds ADD COLUMN tags_config_json TEXT NOT NULL DEFAULT '[]'"
                )
            if "enrich_status" not in b_cols:
                conn.execute(
                    "ALTER TABLE builds ADD COLUMN enrich_status TEXT NOT NULL DEFAULT 'completed'"
                )
            if "completed_by" not in b_cols:
                conn.execute(
                    "ALTER TABLE builds ADD COLUMN completed_by TEXT NOT NULL DEFAULT ''"
                )
            if "awaiting_since" not in b_cols:
                conn.execute("ALTER TABLE builds ADD COLUMN awaiting_since TEXT")
                # Backfill awaiting_since to created_at for builds currently
                # sitting in awaiting_enrich, so the UI staleness clock is
                # meaningful right away rather than NULL.
                conn.execute(
                    "UPDATE builds SET awaiting_since = created_at "
                    "WHERE awaiting_since IS NULL AND enrich_status = 'awaiting_enrich'"
                )
            if "ingest_kind" not in b_cols:
                conn.execute(
                    "ALTER TABLE builds ADD COLUMN ingest_kind TEXT NOT NULL DEFAULT 'full'"
                )

        if "search_misses" not in tables:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS search_misses (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  query_text TEXT NOT NULL,
                  query_embedding_json TEXT,
                  result_count INTEGER NOT NULL DEFAULT 0,
                  top_score REAL NOT NULL DEFAULT 0,
                  tag_filter TEXT,
                  created_at TEXT DEFAULT CURRENT_TIMESTAMP
                );
                CREATE INDEX IF NOT EXISTS idx_search_misses_created ON search_misses(created_at);
                """
            )

        # Answer logs: path breakdown for A2 adaptive weight learning
        if "answer_logs" in tables:
            al_cols = {
                r[1] for r in conn.execute("PRAGMA table_info(answer_logs)").fetchall()
            }
            if "path_breakdown_json" not in al_cols:
                conn.execute(
                    "ALTER TABLE answer_logs ADD COLUMN path_breakdown_json TEXT"
                )

        if "answer_cache" not in tables:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS answer_cache (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  signature TEXT NOT NULL UNIQUE,
                  query_text TEXT NOT NULL,
                  evidence_ids_json TEXT NOT NULL,
                  answer_text TEXT NOT NULL,
                  model_name TEXT,
                  trust_floor REAL NOT NULL DEFAULT 0,
                  hit_count INTEGER NOT NULL DEFAULT 0,
                  created_at TEXT DEFAULT CURRENT_TIMESTAMP
                );
                CREATE INDEX IF NOT EXISTS idx_answer_cache_sig ON answer_cache(signature);
                """
            )

        if "conflict_pending" not in tables:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS conflict_pending (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  build_id TEXT NOT NULL,
                  source_file TEXT NOT NULL,
                  line_start INTEGER NOT NULL,
                  line_end INTEGER NOT NULL,
                  existing_tag TEXT,
                  existing_topic TEXT,
                  incoming_tag TEXT,
                  incoming_topic TEXT,
                  incoming_summary TEXT,
                  incoming_payload_json TEXT,
                  status TEXT NOT NULL DEFAULT 'pending',
                  created_at TEXT DEFAULT CURRENT_TIMESTAMP
                );
                """
            )

        if "ocr_pending" not in tables:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS ocr_pending (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  source_file TEXT NOT NULL,
                  line_no INTEGER NOT NULL,
                  image_ref TEXT NOT NULL,
                  extracted_text TEXT NOT NULL DEFAULT '',
                  status TEXT NOT NULL DEFAULT 'pending',
                  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                  processed_at TEXT
                );
                """
            )

        if "meta_memory" not in tables:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS meta_memory (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  kind TEXT NOT NULL DEFAULT 'rule',
                  text TEXT NOT NULL,
                  scope TEXT NOT NULL DEFAULT 'global',
                  hit_count INTEGER NOT NULL DEFAULT 0,
                  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
                );
                """
            )

        if "pending_format_docs" not in tables:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS pending_format_docs (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  format_id TEXT NOT NULL UNIQUE,
                  topic_name TEXT NOT NULL,
                  title TEXT NOT NULL DEFAULT '',
                  raw_content TEXT NOT NULL,
                  source TEXT NOT NULL DEFAULT '',
                  target_dir TEXT NOT NULL,
                  status TEXT NOT NULL DEFAULT 'awaiting',
                  created_at TEXT DEFAULT CURRENT_TIMESTAMP
                );
                CREATE INDEX IF NOT EXISTS idx_pending_format_status ON pending_format_docs(status);
                """
            )

        if "tag_segments" not in tables:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS tag_segments (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  source_file TEXT NOT NULL,
                  tag TEXT NOT NULL,
                  topic_name TEXT NOT NULL DEFAULT '',
                  line_start INTEGER NOT NULL,
                  line_end INTEGER NOT NULL,
                  summary TEXT NOT NULL DEFAULT '',
                  keywords_json TEXT NOT NULL DEFAULT '[]',
                  entities_json TEXT NOT NULL DEFAULT '[]',
                  is_credential INTEGER NOT NULL DEFAULT 0,
                  created_at TEXT DEFAULT CURRENT_TIMESTAMP
                );
                CREATE INDEX IF NOT EXISTS idx_tag_segments_tag ON tag_segments(tag);
                CREATE INDEX IF NOT EXISTS idx_tag_segments_file ON tag_segments(source_file);
                """
            )
        else:
            ts_cols = {
                r[1] for r in conn.execute("PRAGMA table_info(tag_segments)").fetchall()
            }
            if "topic_name" not in ts_cols:
                conn.execute(
                    "ALTER TABLE tag_segments ADD COLUMN topic_name TEXT NOT NULL DEFAULT ''"
                )
            if "build_id" not in ts_cols:
                conn.execute(
                    "ALTER TABLE tag_segments ADD COLUMN build_id TEXT NOT NULL DEFAULT ''"
                )
            if "centroid_json" not in ts_cols:
                conn.execute(
                    "ALTER TABLE tag_segments ADD COLUMN centroid_json TEXT NOT NULL DEFAULT ''"
                )

        if "search_history" not in tables:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS search_history (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  query_text TEXT NOT NULL,
                  result_count INTEGER NOT NULL DEFAULT 0,
                  tag_filter TEXT,
                  created_at TEXT DEFAULT CURRENT_TIMESTAMP
                )
                """
            )

        if "qa_memories" not in tables:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS qa_memories (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  query_text TEXT NOT NULL,
                  query_embedding_json TEXT,
                  answer_text TEXT NOT NULL,
                  evidence_ids_json TEXT NOT NULL DEFAULT '[]',
                  weights_json TEXT NOT NULL DEFAULT '{}',
                  feedback_score REAL NOT NULL DEFAULT 1.0,
                  used_count INTEGER NOT NULL DEFAULT 0,
                  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
                )
                """
            )

        for tbl in ("rewrite_candidates", "rewrite_validations"):
            if tbl not in tables:
                conn.executescript(
                    f"""
                    CREATE TABLE IF NOT EXISTS rewrite_candidates (
                      id INTEGER PRIMARY KEY AUTOINCREMENT,
                      source_file TEXT NOT NULL,
                      candidate_path TEXT NOT NULL,
                      status TEXT NOT NULL DEFAULT 'validating',
                      validation_start TEXT DEFAULT CURRENT_TIMESTAMP,
                      validation_days INTEGER NOT NULL DEFAULT 7,
                      total_queries INTEGER NOT NULL DEFAULT 0,
                      old_wins INTEGER NOT NULL DEFAULT 0,
                      candidate_wins INTEGER NOT NULL DEFAULT 0,
                      ties INTEGER NOT NULL DEFAULT 0,
                      created_at TEXT DEFAULT CURRENT_TIMESTAMP
                    );
                    CREATE TABLE IF NOT EXISTS rewrite_validations (
                      id INTEGER PRIMARY KEY AUTOINCREMENT,
                      candidate_id INTEGER NOT NULL,
                      query_text TEXT NOT NULL,
                      old_top5_score REAL NOT NULL,
                      candidate_top5_score REAL NOT NULL,
                      winner TEXT NOT NULL,
                      created_at TEXT DEFAULT CURRENT_TIMESTAMP
                    );
                    """
                )
                break

        # Recreate FTS if it's indexing the wrong column (text instead of text_segmented)
        # Check by looking at the FTS config
        try:
            fts_check = conn.execute(
                "SELECT sql FROM sqlite_master WHERE name='chunks_fts'"
            ).fetchone()
            if fts_check and "text_segmented" not in str(fts_check[0] or ""):
                conn.executescript(
                    """
                    DROP TABLE IF EXISTS chunks_fts;
                    DROP TRIGGER IF EXISTS chunks_ai;
                    DROP TRIGGER IF EXISTS chunks_ad;
                    DROP TRIGGER IF EXISTS chunks_au;

                    CREATE VIRTUAL TABLE chunks_fts USING fts5(
                      text_segmented,
                      content='chunks',
                      content_rowid='id'
                    );

                    CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
                      INSERT INTO chunks_fts(rowid, text_segmented) VALUES (new.id, new.text_segmented);
                    END;

                    CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN
                      INSERT INTO chunks_fts(chunks_fts, rowid, text_segmented) VALUES('delete', old.id, old.text_segmented);
                    END;

                    CREATE TRIGGER chunks_au AFTER UPDATE ON chunks BEGIN
                      INSERT INTO chunks_fts(chunks_fts, rowid, text_segmented) VALUES('delete', old.id, old.text_segmented);
                      INSERT INTO chunks_fts(rowid, text_segmented) VALUES (new.id, new.text_segmented);
                    END;

                    -- Rebuild FTS index from existing data
                    INSERT INTO chunks_fts(rowid, text_segmented)
                      SELECT id, text_segmented FROM chunks WHERE text_segmented != '';
                    """
                )
        except Exception:
            pass

        conn.commit()
