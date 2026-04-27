-- Cloud entities + entity_links — knowledge graph powering /v1/graph.
--
-- Source of entities: the classifier ("/v1/enrich/run") emits an
-- `entities` array per tag_segment. _write_segments_done now upserts
-- those into `entities` + builds co-occurrence edges in
-- `entity_links` keyed by workspace.
--
-- Local server has the same shape (server/app/ingest.py); this is
-- the multi-device authoritative version. One device runs enrich,
-- every device reads the graph.

CREATE TABLE IF NOT EXISTS entities (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id    UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    entity_type     TEXT NOT NULL DEFAULT 'concept',
    mention_count   INT NOT NULL DEFAULT 1,
    first_seen      TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_entities_ws_name
    ON entities(workspace_id, name);
CREATE INDEX IF NOT EXISTS idx_entities_ws_count
    ON entities(workspace_id, mention_count DESC);

CREATE TABLE IF NOT EXISTS entity_links (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id    UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    source_entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    target_entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    relation        TEXT NOT NULL DEFAULT 'co-occurs',
    weight          INT NOT NULL DEFAULT 1,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- One edge per (source, target, relation) — UPSERT bumps weight
    -- instead of inserting duplicates.
    CONSTRAINT entity_link_unique
      UNIQUE (workspace_id, source_entity_id, target_entity_id, relation),
    -- Stop self-loops + canonicalize ordering at write time so
    -- (a→b) and (b→a) collapse.
    CONSTRAINT entity_link_distinct
      CHECK (source_entity_id <> target_entity_id)
);
CREATE INDEX IF NOT EXISTS idx_entity_links_ws_weight
    ON entity_links(workspace_id, weight DESC);

-- tag_entity edges: which entities appear under which tag (dimension).
-- Lets the wiki-graph endpoint group nodes by topic.
CREATE TABLE IF NOT EXISTS tag_entities (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id    UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    tag             TEXT NOT NULL,             -- 'wiki:技术阅读', 'work', etc.
    entity_id       UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    count           INT NOT NULL DEFAULT 1,
    CONSTRAINT tag_entity_unique UNIQUE (workspace_id, tag, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_tag_entities_ws_tag
    ON tag_entities(workspace_id, tag);
