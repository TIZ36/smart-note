-- SmartNote Cloud — enrich job queue.
--
-- Status state machine:
--   queued -> dispatched -> running -> done
--                         \-> failed
--   queued -> cancelled
--
-- `executor` is set when the dispatcher picks a path (mcp_pull /
-- ws_relay / cloud_pool). NULL while queued. `result` carries the
-- ClassifyResult shape (segments + token usage) on success; `error`
-- carries the message on failure.
--
-- Redis is the hot path for "what's next to dispatch"; this table is
-- the durable record + audit trail. Both stay in sync via the
-- dispatcher writing to both on transition.

CREATE TABLE IF NOT EXISTS enrich_jobs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  document_id   UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  status        TEXT NOT NULL DEFAULT 'queued',
  executor      TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,
  result        JSONB,
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  dispatched_at TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_enrich_jobs_ws_status
  ON enrich_jobs(workspace_id, status, created_at);

-- Pending pickup queue: filtered partial index keeps mcp_pull /
-- ws_relay polling cheap even when history grows large.
CREATE INDEX IF NOT EXISTS idx_enrich_jobs_pending
  ON enrich_jobs(workspace_id, created_at)
  WHERE status = 'queued';
