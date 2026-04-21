-- SmartNote Cloud — core identity schema.
-- Tenant → Workspace → ApiKey. Workspace members tracked by Supabase user_id.
-- All downstream tables (memories, documents, …) reference workspace_id.

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()

CREATE TABLE IF NOT EXISTS tenants (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workspaces (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, slug)
);

-- Links a Supabase auth user to a workspace with a role. `user_id` is the
-- Supabase `auth.users.id` (UUID, stored as text so we can also seed
-- synthetic ids like 'dev-bootstrap' in local dev.)
CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL,
  role         TEXT NOT NULL DEFAULT 'member',  -- owner | admin | member
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);

-- API keys identify an *agent* acting on a workspace. The secret is NEVER
-- stored — only sha256(secret). `prefix` is both the human-visible prefix
-- (shown in the console as `sn_live_ab12cd…`) and the lookup index at
-- token-exchange time; it's generated client-safely (no secret leak).
CREATE TABLE IF NOT EXISTS api_keys (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  prefix        TEXT NOT NULL UNIQUE,
  secret_hash   TEXT NOT NULL,
  scopes        TEXT[] NOT NULL DEFAULT '{}',
  agent_id      TEXT,                       -- "claude-code" / "cursor" / custom
  last_used_at  TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ,
  created_by    TEXT,                       -- Supabase user_id, or 'dev-bootstrap'
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_api_keys_workspace ON api_keys(workspace_id);
