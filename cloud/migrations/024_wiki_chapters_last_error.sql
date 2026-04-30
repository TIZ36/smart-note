-- v1.2 P2-2 — surface per-chapter wiki_phase_b errors.
--
-- Empty `summary` was overloaded: it could mean "not yet summarized"
-- OR "LLM returned junk OR provider 500'd". `summary_sha` only stamps
-- on success, so users had no way to tell apart a chapter that hadn't
-- been processed from one whose run failed.
--
-- last_error captures the latest failure reason so the desktop's
-- Library KN → Chapters tab can render a red dot + tooltip per row.
-- Cleared on a subsequent successful run (the executor sets it back
-- to NULL alongside writing summary).

ALTER TABLE wiki_chapters
  ADD COLUMN IF NOT EXISTS last_error TEXT;
