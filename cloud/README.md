# SmartNote Cloud

Multi-tenant cloud SaaS track for SmartNote — an Agent Memory-as-a-Service for
Claude Code, Cursor, and any other MCP-compatible agent.

**Status:** pre-alpha, W1 of 8-week MVP plan.

**Relationship to the rest of the repo:** this folder is a clean fork — it does
not import from `server/` or `desktop/`. Reusable modules (retrieval, packs,
embedding service) are copied in as needed and evolved independently for the
multi-tenant model. The local OSS desktop app remains self-contained under
`server/` + `desktop/`.

## Layout

```
cloud/
  api/         FastAPI service — REST v1 endpoints, Supabase auth, Postgres
  sdk-py/      Python SDK (Client, auto token renewal)
  sdk-ts/      TypeScript SDK
  console/     Next.js admin console (deferred to W7)
  migrations/  Postgres schema migrations (SQL files, run via psql or sqitch)
  infra/       docker-compose + deployment scaffolding
```

## Local bring-up

Prereqs: Docker, Docker Compose v2, a Supabase project (for auth).

```bash
cd cloud/infra
cp .env.example .env
# edit .env — fill in SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
docker compose up --build
```

Services:

- `postgres` — Postgres 16 + pgvector on :5432
- `embed`    — self-hosted sentence-transformers (reuses repo's `local_embedding/`)
- `api`      — FastAPI gateway on :8000

Health-check everything: `curl http://localhost:8000/v1/health`.

## Design decisions (locked)

| Area | Choice |
|------|--------|
| Auth | Supabase Auth (OAuth first-time → API key → JWT with auto-refresh in SDK) |
| Database | Postgres + pgvector (multi-tenant; every table carries workspace_id) |
| Embeddings | Self-hosted sentence-transformers first, pluggable OpenAI fallback |
| SDK at launch | Python + TypeScript |
| Pricing | ¥9.9 / ¥99 / $199 per month |

See `cloud/api/README.md` for the API surface and per-endpoint spec (filled in
as endpoints land).
