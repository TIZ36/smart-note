-- SmartNote Cloud — memory lifecycle + access instrumentation.
--
-- MLflow-inspired pattern:
--   * `status` is the lifecycle stage (analogous to MLflow's
--     model-registry stages) — default retrieve filters to
--     'active' + 'pinned' so archived rows don't clutter results.
--   * `access_count` + `last_accessed_at` are the "metrics" that
--     feed decay (analogous to MLflow autologged metrics).
--
-- All columns have sensible defaults so existing rows stay active
-- and countable from ingest time.

ALTER TABLE memories
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';
  -- Allowed values: 'active' | 'stale' | 'archived' | 'draft'
  -- `pinned` stays as its own boolean — it's orthogonal (a pinned
  -- row can be active or stale; pinned survives decay regardless).

ALTER TABLE memories
  ADD COLUMN IF NOT EXISTS access_count BIGINT NOT NULL DEFAULT 0;

ALTER TABLE memories
  ADD COLUMN IF NOT EXISTS last_accessed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_memories_status
  ON memories(workspace_id, status);

-- Decay candidates: non-pinned, non-archived, not accessed recently.
-- Partial index keeps the workload cheap even when the table grows.
CREATE INDEX IF NOT EXISTS idx_memories_decay_candidates
  ON memories(workspace_id, last_accessed_at)
  WHERE status IN ('active', 'stale') AND pinned = false;
