-- v1.2 P2-1f — backfill historical enrich_jobs into processing_runs.
--
-- The new ledger started receiving rows at commit dbfcf42 (write-
-- through). All enrich_jobs predating that, plus the ones we keep
-- writing alongside until the legacy table is fully retired, are
-- invisible from the canonical surface. UI consumers about to flip
-- onto processing_runs would lose every doc's run history at
-- cutover. Backfill closes that gap.
--
-- What gets backfilled:
--   - Only terminal rows (status in 'done' / 'failed') — queued /
--     running rows are by definition stale at backfill time
--   - Existing processing_runs rows skip via the unique partial
--     index on (workspace, doc, kind, input_sha)
--
-- input_sha: backfilled rows carry a synthetic per-job sha so each
-- legacy job lands as its own row even when multiple jobs ran
-- against the same doc with the same revision. The 'backfill:'
-- prefix tags them clearly so debugging knows these aren't from a
-- live runs_ledger.start() call.
--
-- Idempotent: re-running the migration is a no-op (the WHERE NOT
-- EXISTS guard catches anything we already inserted on a prior run).

INSERT INTO processing_runs (
  id, workspace_id, document_id, kind, status, executor,
  result, error, input_sha, input_snapshot, revision,
  trigger_kind, trigger_ref, attempts,
  created_at, started_at, finished_at
)
SELECT
  gen_random_uuid(),
  ej.workspace_id,
  ej.document_id,
  -- Wiki Phase B rows landed in enrich_jobs with executor='wiki_phase_b'
  -- (commit eef51e5). Map them onto kind='wiki_abstract' in the
  -- ledger; everything else is ai_enrich.
  CASE
    WHEN ej.executor = 'wiki_phase_b' THEN 'wiki_abstract'
    ELSE 'ai_enrich'
  END,
  CASE
    WHEN ej.status = 'done' THEN 'done'
    WHEN ej.status = 'failed' THEN 'failed'
    ELSE ej.status
  END,
  ej.executor,
  ej.result,
  ej.error,
  -- synthetic per-job sha, prefixed so it can't collide with live
  -- runs_ledger.start() output (those are pure hex from sha256)
  'backfill:' || ej.id::text,
  jsonb_build_object(
    'backfill', true,
    'source_table', 'enrich_jobs',
    'source_id', ej.id::text
  ),
  0,
  'backfill',
  'migration_025',
  COALESCE(ej.attempts, 0),
  ej.created_at,
  ej.dispatched_at,
  ej.finished_at
FROM enrich_jobs ej
WHERE ej.status IN ('done', 'failed')
  AND NOT EXISTS (
    SELECT 1 FROM processing_runs pr
    WHERE pr.input_sha = 'backfill:' || ej.id::text
  );

-- Note: we don't backfill chunk_embed (no historical surface — the
-- old ingest_runs table is unrelated and structurally different) or
-- wiki_abstract (commit eef51e5 forward, every wiki run already
-- writes to enrich_jobs with executor='wiki_phase_b' and from
-- dbfcf42 also writes to processing_runs, so the ledger has the
-- forward record).
