# cloud/api — SmartNote Cloud API service

FastAPI + Supabase auth + Postgres (pgvector).

## Endpoint plan (MVP)

Filled in as each ticket lands. Unchecked = not yet implemented.

- [x] `GET  /v1/health`
- [ ] `POST /v1/auth/token`         — exchange API key for JWT
- [ ] `POST /v1/auth/refresh`       — refresh JWT with refresh_token
- [ ] `GET  /v1/me`                 — current identity + scopes
- [ ] `POST /v1/workspaces`
- [ ] `GET  /v1/workspaces`
- [ ] `POST /v1/workspaces/{id}/api-keys`
- [ ] `DELETE /v1/workspaces/{id}/api-keys/{key_id}`
- [ ] `POST /v1/memories`
- [ ] `GET  /v1/memories`            — filters: kind, scope, tag, q, since
- [ ] `GET  /v1/memories/{id}`
- [ ] `PATCH /v1/memories/{id}`
- [ ] `DELETE /v1/memories/{id}`
- [ ] `GET  /v1/preferences`         — flat KV sugar over kind=preference
- [ ] `PUT  /v1/preferences/{key}`
- [ ] `POST /v1/retrieve`            — hybrid retrieval over memories
- [ ] `POST /v1/documents`
- [ ] `POST /v1/documents/{id}/ingest`

## Running (without docker)

```bash
cd cloud/api
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

Expects `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `EMBED_URL`
in env — see `cloud/infra/.env.example`.
