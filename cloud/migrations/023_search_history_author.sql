-- 023 · search_history.author — track who issued a query.
--
-- Before: every row implicitly attributed to the workspace owner.
-- After:  user-driven searches via /v1/chunks/search → author NULL
--         (back-compat) or 'user'; agent-driven searches via the
--         search_memory MCP tool → author = agent name (e.g.
--         'Claude Code', 'Cursor', 'Opencode').
--
-- Lets the desktop Stream feed render agent queries alongside the
-- user's own ("Cursor asked: …" vs "You asked: …") so the user sees
-- what their AI CLIs are reading and can flag suspicious patterns.

ALTER TABLE search_history
  ADD COLUMN IF NOT EXISTS author TEXT;

-- Index for "show me only what agent X searched" filtering.
CREATE INDEX IF NOT EXISTS idx_search_history_author_at
  ON search_history(workspace_id, author, created_at DESC);
