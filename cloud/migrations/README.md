# cloud/migrations — Postgres schema

One SQL file per migration, numeric prefix for ordering. Idempotent
(`CREATE ... IF NOT EXISTS`) where possible so re-running on a fresh
container is safe.

Applied via a simple runner at api startup — see `app/db.py` (added in W2).

## Planned migrations

- `001_core.sql`       — tenants, workspaces, workspace_members, api_keys
- `002_memories.sql`   — unified memories table + pgvector index
- `003_documents.sql`  — documents + ingest jobs
- `004_quotas.sql`     — metering columns (enforcement deferred)

## pgvector notes

We size vectors at **384 dims** to match `all-MiniLM-L6-v2` (the self-hosted
embedding model reused from the OSS repo's `local_embedding/`). If we swap
models later the column type must be re-created — a full re-embed is cheaper
than trying to keep two shapes around, so plan for hard cutovers.

## Multi-tenancy convention

Every table carries `workspace_id UUID NOT NULL` and every query filters on
it. Row-Level Security (RLS) policies will be added in W4 once the auth
middleware reliably sets `current_setting('app.workspace_id')`.
