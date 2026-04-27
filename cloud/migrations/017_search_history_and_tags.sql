-- Stage D — search_history + workspace tags cloud-side.
--
-- search_history: every /v1/chunks/search call appends here so the
-- desktop's "Recent searches" panel survives device switches. Capped
-- at 1000 rows per workspace via a vacuum trigger we'll add later;
-- for now just rely on natural DELETE workflow.
--
-- tags: workspace-level tag definitions (name, description, color).
-- Mirrors the local tags.json shape so the migration is one-liner.

CREATE TABLE IF NOT EXISTS search_history (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id  UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    query_text    TEXT NOT NULL,
    result_count  INT NOT NULL DEFAULT 0,
    tag_filter    TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_search_history_ws_at
    ON search_history(workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS workspace_tags (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id  UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name          TEXT NOT NULL,
    description   TEXT NOT NULL DEFAULT '',
    color         TEXT NOT NULL DEFAULT 'gray',
    sort_order    INT NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT workspace_tag_unique UNIQUE (workspace_id, name)
);
CREATE INDEX IF NOT EXISTS idx_workspace_tags_ws
    ON workspace_tags(workspace_id, sort_order);
