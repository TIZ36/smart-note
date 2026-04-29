-- v1.2 Phase 0 / P0-3 — unified processing run ledger.
--
-- See docs/processing-pipeline.md §2.3.
--
-- Replaces the three legacy progress surfaces (`ingest_runs`,
-- `enrich_jobs`, ad-hoc progress JSONB) with one append-only table
-- the desktop, AI CLI, and Cloud Console all read.
--
-- Append-only: a force re-run does NOT overwrite the prior row. It
-- bumps `revision`, which feeds `input_sha`, which queues a fresh
-- row. Audit chain is the full row history per (doc, kind).

CREATE TABLE IF NOT EXISTS processing_runs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  document_id  UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,           -- chunk_embed | ai_enrich | wiki_abstract
  status       TEXT NOT NULL,           -- queued | running | done | failed | skipped_dedup | skipped_quota
  executor     TEXT,                    -- cloud_pool | mcp_pull | ws_relay | inline
  progress     JSONB NOT NULL DEFAULT '{}'::jsonb,
  result       JSONB,
  error        TEXT,

  -- input_sha = sha256 over the snapshot below. Any change in any
  -- snapshot field invalidates dedup.
  input_sha    TEXT NOT NULL,

  -- Snapshot of every input that participated in input_sha, captured
  -- at enqueue time. Source of truth at execute time — the executor
  -- reads from here, not from current workspace state. Editing
  -- workspace_tags between enqueue and execute leaves a queued run
  -- unaffected (the run carries the tag list it was queued with).
  --   Shape:
  --     { "tag_vocab_sha": "...", "tag_vocab": [...],
  --       "prompt_version": "v3", "content_sha": "...",
  --       "executor_kind": "cloud_pool", "revision": 0 }
  input_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Bumped by force=true on POST /v1/processing/.../run. Carried into
  -- input_sha so a forced re-run is a new row, not an overwrite.
  revision     INT NOT NULL DEFAULT 0,

  -- Who/what triggered this run. Split so dashboards aggregate on
  -- trigger_kind without parsing strings.
  --   trigger_kind = 'auto'    : ref ∈ {'document_created', 'document_updated'}
  --   trigger_kind = 'api_key' : ref = api_keys.id (UUID as text)
  --   trigger_kind = 'cron'    : ref = job name
  trigger_kind TEXT NOT NULL,
  trigger_ref  TEXT NOT NULL,

  attempts     INT NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at   TIMESTAMPTZ,
  finished_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS runs_doc_kind
  ON processing_runs(document_id, kind, created_at DESC);

CREATE INDEX IF NOT EXISTS runs_pending
  ON processing_runs(workspace_id, kind, created_at)
  WHERE status IN ('queued', 'running');

CREATE INDEX IF NOT EXISTS runs_trigger
  ON processing_runs(workspace_id, trigger_kind, trigger_ref, created_at DESC);

-- Active dedup. At most one non-terminal-or-done row per (doc, kind,
-- input_sha). 'failed' / 'skipped_*' rows are excluded so retries can
-- land; 'done' rows are included so a re-ask returns the existing
-- successful row.
CREATE UNIQUE INDEX IF NOT EXISTS runs_dedup
  ON processing_runs(workspace_id, document_id, kind, input_sha)
  WHERE status IN ('queued', 'running', 'done');
