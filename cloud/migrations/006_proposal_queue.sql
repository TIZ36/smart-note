-- SmartNote Cloud — proposal queue extension to memories.
--
-- MLflow autolog inspiration: agents don't hard-decide "this is worth
-- remembering." They propose candidates into a draft queue, the user
-- (or an agent with accept policy) reviews → active.
--
-- We reuse the memories table + status='draft' from migration 005.
-- Only three new columns:
--   proposal_reason — why the proposer thinks this matters (free text,
--                     surfaced to reviewer)
--   reviewed_at     — NULL until accept/reject, audit field
--   reviewed_by     — identity (agent name or user id) who resolved
--
-- author_agent already captures the proposer (they're the row's
-- creator). proposed_at ≈ created_at. No need for separate columns.

ALTER TABLE memories ADD COLUMN IF NOT EXISTS proposal_reason TEXT;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS reviewed_by TEXT;

-- The draft queue will be read often when agents/users inspect it;
-- a partial index keyed on draft status keeps the query cheap.
CREATE INDEX IF NOT EXISTS idx_memories_draft_queue
  ON memories(workspace_id, created_at DESC)
  WHERE status = 'draft';
