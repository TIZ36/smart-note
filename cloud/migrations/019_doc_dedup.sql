-- v1.2 Phase 0 / P0-1 — document-level content fingerprint for dedup.
--
-- See docs/processing-pipeline.md §2.1.
--
-- Why a plain column + trigger instead of GENERATED ALWAYS AS STORED:
-- adding a stored generated column to an existing table forces a full
-- rewrite (minutes-long exclusive lock on prod-sized documents). A
-- plain column starts NULL, the trigger backfills new rows, and a
-- one-shot script (cloud/api/scripts/backfill_doc_sha.py) walks the
-- existing rows in chunked transactions.
--
-- Idempotency: every statement uses IF NOT EXISTS / OR REPLACE so the
-- runner can re-apply this file safely. The trigger drops itself
-- before recreating to keep upgrades clean if we change the body.

-- Step 1: nullable column. Constant-time DDL; no rewrite.
ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS content_sha256 TEXT;

-- Step 2: trigger so all new INSERTs and content UPDATEs populate the
-- column. Same algorithm as the Python helper in storage.service so
-- caller-supplied sha (from create_document) matches what the trigger
-- would compute. We keep the trigger as a safety net for any future
-- write path that forgets to compute sha client-side.
CREATE OR REPLACE FUNCTION documents_set_content_sha256()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.content_sha256 IS NULL AND NEW.content IS NOT NULL THEN
    NEW.content_sha256 := encode(digest(NEW.content, 'sha256'), 'hex');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS documents_content_sha256_ins ON documents;
CREATE TRIGGER documents_content_sha256_ins
  BEFORE INSERT OR UPDATE OF content ON documents
  FOR EACH ROW EXECUTE FUNCTION documents_set_content_sha256();

-- Step 3: unique index. Plain CREATE INDEX is fine at MVP scale
-- (sub-second on <100k docs). For prod-size deployments where this
-- file is applied to a hot table, run the equivalent CONCURRENTLY
-- statement out-of-band before invoking the API process — the runner
-- here uses an implicit transaction which cannot wrap CONCURRENTLY:
--
--   psql ... -c "CREATE UNIQUE INDEX CONCURRENTLY documents_dedup
--                  ON documents(workspace_id, content_sha256);"
--
-- Then the IF NOT EXISTS below becomes a no-op on next API start.
CREATE UNIQUE INDEX IF NOT EXISTS documents_dedup
  ON documents(workspace_id, content_sha256);
