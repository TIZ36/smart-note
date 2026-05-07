# SmartNote Cloud — Log Query Panel

**Internal developer tool.** SLS-Log-style viewer over the cloud's
`pipeline_events` table — every run, every event, across every
workspace.

## What it shows

For every pipeline run (`chunk_embed` / `ai_enrich` / `wiki_abstract`
/ `note_classify` / `graph`), every event the cloud emitted: queued
→ running → progress ticks → done | failed | partial | skipped.
Plus the LLM cost / token counts / model / executor / mode each
event carried.

- **Stats strip** — top row: runs, events, errors, workspaces, LLM
  cost — all 24h roll-ups
- **Recent runs** — left pane, last 50 runs, optionally filtered by
  workspace
- **Search** — `q` text + filters by workspace / stage / status
- **Run detail** — name-plate header (status, duration, cost, model)
  + full event timeline with inline summary + raw JSON per event
- **Deep links** — `?run=<run_id>` opens straight to a run

## Run

From `cloud/infra/`:

```bash
docker compose up --build log-panel
```

Open <http://localhost:8090/>. Override the port via `LOG_PANEL_PORT`
in `.env` if 8090 conflicts.

There is **no API key**. The panel reads Postgres directly via the
shared `DATABASE_URL`. Deploy on internal network only.

## Architecture

```
   browser ──▶ log-panel:8090 ──▶ postgres
                  │
                  ├ /                 SPA shell
                  ├ /health           liveness + db-connected
                  ├ /api/recent_runs  most recent N runs
                  ├ /api/runs/<id>    full event chain
                  ├ /api/search       q / stage / status / workspace / since / until
                  ├ /api/workspaces   distinct workspaces with recent activity
                  └ /api/stats        24h roll-ups
```

The panel runs `asyncpg` against `pipeline_events`. No auth — any
request reaches the data. The security boundary is "is this port
reachable from outside the dev VPC".

## Endpoints

| route                          | what                                  |
|--------------------------------|---------------------------------------|
| `GET /api/recent_runs`         | most-recent runs, optional `workspace_id` filter |
| `GET /api/runs/{run_id}`       | full event chain for one run + roll-ups |
| `GET /api/search`              | filtered events: workspace_id, document_id, stage, status, q, since, until, cursor |
| `GET /api/workspaces`          | distinct workspaces with activity     |
| `GET /api/stats`               | 24h totals (events, runs, errors, workspaces, cost) |

## Retention

`pipeline_events` is append-only. There is no automatic prune yet —
add one when the table grows past comfort:

```sql
DELETE FROM pipeline_events WHERE at < now() - interval '30 days';
```
