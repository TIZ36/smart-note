-- SmartNote Cloud — per-workspace usage counters.
-- Pure counters at MVP: we surface them in admin UIs and in the future
-- use them for billing. Enforcement (hard caps per tier) is deferred —
-- the point of landing the table now is so every write path can be
-- plumbed through incr_usage() before we need to start rejecting.

CREATE TABLE IF NOT EXISTS workspace_usage (
  workspace_id    UUID PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  memory_count    BIGINT NOT NULL DEFAULT 0,
  document_count  BIGINT NOT NULL DEFAULT 0,
  embed_tokens    BIGINT NOT NULL DEFAULT 0,
  retrieve_calls  BIGINT NOT NULL DEFAULT 0,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Month-grained snapshots so we can compute "this month" without rolling
-- our own event log. Only written on the first usage event per month
-- (lazy initialization in app code).
CREATE TABLE IF NOT EXISTS workspace_usage_monthly (
  workspace_id  UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  month         TEXT NOT NULL,                    -- YYYY-MM
  memory_count  BIGINT NOT NULL DEFAULT 0,
  embed_tokens  BIGINT NOT NULL DEFAULT 0,
  retrieve_calls BIGINT NOT NULL DEFAULT 0,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, month)
);
