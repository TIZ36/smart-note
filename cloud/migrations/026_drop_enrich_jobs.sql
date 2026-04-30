-- v1.2 P2-1 final — drop the legacy enrich_jobs table.
--
-- Every reader migrated to processing_runs in 4def060 / f1f37f5.
-- Every writer dropped in commit ____. The table holds only
-- backfilled-from rows at this point (migration 025 copied them
-- into processing_runs already).
--
-- Order:
--   1. processing_runs is canonical surface (021)
--   2. backfill copied terminal rows (025)
--   3. UI consumers migrated (4def060)
--   4. /v1/enrich/* routes migrated (this PR)
--   5. writers retired (this PR)
--   6. table dropped (this migration)
--
-- Idempotent: DROP TABLE IF EXISTS so re-applying is safe.

DROP TABLE IF EXISTS enrich_jobs CASCADE;
