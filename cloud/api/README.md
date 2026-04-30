# cloud/api — SmartNote Cloud API service

FastAPI + Supabase auth + Postgres (pgvector).

## Endpoint Snapshot

- [x] `GET  /v1/health`
- [x] `POST /v1/auth/token`         — exchange API key for JWT
- [ ] `POST /v1/auth/refresh`       — refresh JWT with refresh_token
- [ ] `GET  /v1/me`                 — current identity + scopes
- [x] `POST /v1/workspaces`
- [x] `GET  /v1/workspaces`
- [x] `POST /v1/workspaces/{id}/api-keys`
- [x] `DELETE /v1/workspaces/{id}/api-keys/{key_id}`
- [x] `POST /v1/memories`
- [x] `GET  /v1/memories`            — filters: kind, scope, tag, q, since
- [x] `GET  /v1/memories/{id}`
- [x] `PATCH /v1/memories/{id}`
- [x] `DELETE /v1/memories/{id}`
- [x] `GET  /v1/preferences`         — flat KV sugar over kind=preference
- [x] `PUT  /v1/preferences/{key}`
- [x] `POST /v1/retrieve`            — hybrid retrieval over memories
- [x] `POST /v1/documents`
- [x] `POST /v1/ingest/document`     — kind-aware chunk/embed ingest

## Running (without docker)

```bash
cd cloud/api
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

Expects `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `EMBED_URL`
in env — see `cloud/infra/.env.example`.
