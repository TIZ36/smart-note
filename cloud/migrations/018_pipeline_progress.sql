-- Live pipeline progress for the desktop "Ingest All / Accumu" dialog.
--
-- Both tables already track terminal status (queued/running/done/failed)
-- and post-hoc counts; this column carries the *during-run* phase + per-
-- phase counters that the UI polls to render a moving progress bar.
--
-- Schema is intentionally loose JSON — phases evolve faster than DDL,
-- and the desktop renders whatever keys are present.

ALTER TABLE enrich_jobs
  ADD COLUMN IF NOT EXISTS progress JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE ingest_runs
  ADD COLUMN IF NOT EXISTS progress JSONB NOT NULL DEFAULT '{}'::jsonb;
