import os
import sqlite3

from app.config import settings


SCHEMA = """
PRAGMA journal_mode=WAL;

CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
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
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_chunks_dimension ON chunks(dimension);
CREATE INDEX IF NOT EXISTS idx_chunks_project_slug ON chunks(project_slug);

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

CREATE TABLE IF NOT EXISTS tag_segments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_file TEXT NOT NULL,
  tag TEXT NOT NULL,
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
    return conn


def init_db() -> None:
    with connect() as conn:
        conn.executescript(SCHEMA)
        conn.commit()


def migrate_db() -> None:
    """Add new columns to existing databases without data loss."""
    with connect() as conn:
        # Check existing columns
        columns = {
            row[1] for row in conn.execute("PRAGMA table_info(chunks)").fetchall()
        }
        new_cols = {
            "text_segmented": "TEXT NOT NULL DEFAULT ''",
            "keywords_json": "TEXT NOT NULL DEFAULT '[]'",
            "entities_json": "TEXT NOT NULL DEFAULT '[]'",
            "ai_summary": "TEXT NOT NULL DEFAULT ''",
        }
        for col, typedef in new_cols.items():
            if col not in columns:
                conn.execute(f"ALTER TABLE chunks ADD COLUMN {col} {typedef}")

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
            # Add topic_name column if missing
            ts_cols = {r[1] for r in conn.execute("PRAGMA table_info(tag_segments)").fetchall()}
            if "topic_name" not in ts_cols:
                conn.execute("ALTER TABLE tag_segments ADD COLUMN topic_name TEXT NOT NULL DEFAULT ''")

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
