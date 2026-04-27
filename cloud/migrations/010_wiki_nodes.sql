-- SmartNote Cloud — wiki nodes (smartsheet-hybrid via ltree).
--
-- Decision K: rather than building a custom B+ tree, we lean on
-- Postgres `ltree` for the hierarchical key path. Each wiki node has
-- a `path` like `tech.frontend.react.hooks` — ltree gives us:
--   * fast ancestor/descendant queries (`@>`, `<@`)
--   * regex-style pattern matching (`~ 'tech.*.react.*'`)
--   * GIST index for sub-millisecond hierarchy lookups at MVP scale
--
-- The "smartsheet" overlay (column groupings, derived metrics) lives
-- in `attrs JSONB` so we can iterate without schema churn. When usage
-- patterns crystallize we'll promote hot attrs to real columns.

CREATE EXTENSION IF NOT EXISTS ltree;

CREATE TABLE IF NOT EXISTS wiki_nodes (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  path         LTREE NOT NULL,
  title        TEXT NOT NULL,
  summary      TEXT NOT NULL DEFAULT '',
  source_ids   UUID[] NOT NULL DEFAULT '{}',  -- documents that contributed
  attrs        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wiki_nodes_path_gist
  ON wiki_nodes USING GIST (path);
CREATE INDEX IF NOT EXISTS idx_wiki_nodes_ws_path
  ON wiki_nodes(workspace_id, path);
CREATE UNIQUE INDEX IF NOT EXISTS idx_wiki_nodes_ws_path_unique
  ON wiki_nodes(workspace_id, path);
