-- v3.6 — fine-grained event log for pipeline runs.
--
-- processing_runs (021) records start + finish per stage run. The log
-- query panel needs the in-between stream too: queued / running /
-- progress ticks / done / failed / partial / skipped — every event
-- the WS protocol broadcasts. This table is that durable stream.
--
-- Append-only. Writers: realtime_protocol.broadcast() persists every
-- payload that has a run_id. Readers: GET /v1/logs/runs/{run_id} +
-- /v1/logs/search.
--
-- Retention: pruned by a separate job to N days (default 30) — not
-- enforced here because retention is a config concern, not a schema
-- concern.

CREATE TABLE IF NOT EXISTS pipeline_events (
  id           BIGSERIAL PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id       UUID,                  -- references processing_runs(id); nullable so legacy/partial broadcasts still land
  document_id  UUID,                  -- references documents(id); nullable for workspace-scoped events
  stage        TEXT,                  -- chunk_embed | ai_enrich | wiki_abstract | note_classify | graph
  event        TEXT NOT NULL,         -- chunk_embed_started | enrich_done | … (matches realtime_protocol.event_payload)
  status       TEXT,                  -- queued | running | done | failed | partial | skipped
  message      TEXT,
  error        TEXT,
  schema_version INT NOT NULL DEFAULT 1,
  data         JSONB NOT NULL DEFAULT '{}'::jsonb,
  at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Lookup by run_id is the dominant access path (modal "open in logs" lands here).
CREATE INDEX IF NOT EXISTS pipeline_events_run
  ON pipeline_events(run_id, at);

-- Workspace-scoped time-window scan (search panel default view).
CREATE INDEX IF NOT EXISTS pipeline_events_ws_at
  ON pipeline_events(workspace_id, at DESC);

-- Stage + status filters in /v1/logs/search.
CREATE INDEX IF NOT EXISTS pipeline_events_filter
  ON pipeline_events(workspace_id, stage, status, at DESC);

-- jsonb GIN for ad-hoc data search ("show events whose data->>cost_usd > X").
CREATE INDEX IF NOT EXISTS pipeline_events_data_gin
  ON pipeline_events USING GIN (data);
