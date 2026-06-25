<h1 align="center">SmartNote</h1>

<p align="center">
  <strong>A cloud-hosted memory + notes service your AI agents talk to over MCP.</strong><br/>
  pgvector + LLM enrichment · REST API · Python &amp; TypeScript SDKs ·
  exposed to Claude Code / Cursor / Opencode through a native MCP endpoint.
</p>

<p align="center">
  <a href="#-quick-start">Quick Start</a> ·
  <a href="#-mcp-for-ai-agents">MCP</a> ·
  <a href="#-rest-api--sdks">REST API &amp; SDKs</a> ·
  <a href="#-architecture">Architecture</a> ·
  <a href="#-troubleshooting">Troubleshooting</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/python-3.12-3776AB?logo=python&logoColor=fff" alt="Python 3.12" />
  <img src="https://img.shields.io/badge/postgres-pgvector-336791?logo=postgresql&logoColor=fff" alt="Postgres + pgvector" />
  <img src="https://img.shields.io/badge/MCP-streamable--http-7C3AED" alt="MCP streamable-http" />
  <img src="https://img.shields.io/badge/license-MIT-22c55e" alt="MIT" />
</p>

---

## Why SmartNote

SmartNote is a self-hosted memory and notes backend for AI agents. There is no GUI — the product is the API:

- 🤖 **Agents see your notes as first-class memory.** A native MCP streamable-HTTP server lets Claude Code / Cursor / Opencode call `search`, `add_memory`, `add_document`, `set_preference` — scoped to a workspace.
- ☁️ **The cloud does the work AI needs.** A small FastAPI service chunks, embeds (pgvector), enriches with your LLM, and builds an entity graph across documents.
- 🧰 **REST + SDKs for everything else.** Anything the MCP tools do is also reachable over the `/v1/*` REST API, with first-party Python and TypeScript SDKs.
- 🔑 **One API key.** No SaaS account, no per-tool wiring. Issue once, paste anywhere.

---

## 🚀 Quick Start

You need one thing: the cloud stack (Docker). Total time: ~5 minutes.

### 1 · Bring up the cloud

```bash
git clone https://github.com/TIZ36/smart-note.git
cd smart-note
./scripts/restart-cloud.sh
```

This builds the API image, starts Postgres + pgvector + the embed service, and runs migrations. When it prints `✓ api healthy`, you have:

| Service | URL |
|---|---|
| REST API | `http://localhost:58000` |
| MCP endpoint | `http://localhost:58000/mcp/` |
| Postgres | `localhost:55432` |
| Embedding service | `http://localhost:58009` |

> **First run takes longer**: the embed-model image downloads ~600 MB. Subsequent boots are seconds.

### 2 · Mint a workspace API key

```bash
./scripts/issue-cloud-apikey.sh
```

You get an `sn_live_…` token printed **once**. Save it — it scopes everything below to one workspace.

### 3 · Connect an MCP client

Point any modern MCP client at the `/mcp/` endpoint with the token as a bearer header (see [MCP for AI agents](#-mcp-for-ai-agents)). Or talk to the REST API / SDKs directly (see [REST API & SDKs](#-rest-api--sdks)).

<details>
<summary><strong>Tear down / reset</strong></summary>

```bash
# Stop cloud, keep data
cd cloud/infra && docker compose down

# Stop + wipe DB (clean slate)
cd cloud/infra && docker compose down -v
```
</details>

---

## 🤖 MCP for AI agents

SmartNote exposes a native MCP streamable-HTTP endpoint at `/mcp/`. **No stdio bridge, no spawn, no absolute paths.** Any modern MCP client connects with just a URL + bearer token.

### Claude Code · Cursor · Opencode

Project-scoped config (e.g. `.mcp.json`):

```json
{
  "mcpServers": {
    "smartnote": {
      "url": "http://localhost:58000/mcp/",
      "headers": {
        "Authorization": "Bearer sn_live_..."
      }
    }
  }
}
```

### Tools the agent gets

| Tool | What it does |
|---|---|
| `search` | **Default lookup** — fans out to memories ∪ document chunks in parallel, merges by score. |
| `search_memory` / `search_documents` | Source-scoped variants. |
| `add_memory` · `set_preference` | Persist a fact or preference (supersede history kept). |
| `propose_memory` | Submit a draft memory for user review (lands in the pending-proposals queue). |
| `add_document` · `update_document` · `append_to_document` · `delete_document` | Manage long-form notes (upload → chunk → embed). |
| `get_document` · `get_memory` | Fetch full content by id. |
| `queue_enrich_jobs` · `submit_enrichments` | Drive cloud-side LLM enrichment. |
| `set_enrich_provider` | Configure the workspace's cloud-side LLM. |

Every tool is workspace-scoped via the bearer key — one workspace per key.

---

## 🔌 REST API & SDKs

Everything the MCP tools expose is also available over the `/v1/*` REST API. Get a short-lived JWT from your `sn_live_…` key, then call the endpoints:

```bash
curl -X POST http://localhost:58000/v1/auth/token \
  -H "Content-Type: application/json" \
  -d '{"api_key": "sn_live_…"}'
# expect: {"jwt": "...", "expires_at": …}
```

First-party SDKs wrap the same surface:

| SDK | Location |
|---|---|
| Python | `cloud/sdk-py/` |
| TypeScript | `cloud/sdk-ts/` |

Both target the REST API (documents, memories, preferences, search, enrichment) using a workspace API key.

---

## 🏗 Architecture

```
                          ┌─────────────────────────────┐
   AI agents (MCP)  ──────►  Cloud (single Docker host)  │
   /mcp streamable        │                              │
                          │  ┌──────────────────────┐    │
   SDKs / REST clients ───►  │ FastAPI (cloud/api/) │    │
   /v1/* HTTP             │  │   /v1/* REST         │    │
                          │  │   /mcp (streamable)  │    │
                          │  └──────────┬───────────┘    │
                          │             │                │
                          │  ┌──────────▼───────────┐    │
                          │  │ Postgres + pgvector  │    │
                          │  │   documents          │    │
                          │  │   chunks, blobs      │    │
                          │  │   memories           │    │
                          │  │   entities + links   │    │
                          │  └──────────────────────┘    │
                          │                              │
                          │  ┌──────────────────────┐    │
                          │  │ Embedding service    │    │
                          │  │ (self-hosted)        │    │
                          │  └──────────────────────┘    │
                          └─────────────────────────────┘

Processing pipeline (per document):
  chunk_embed   ──►  chunk_enrich       ──►  graph_topology
   (chunks +         (LLM tags · topics       (cross-doc links:
    pgvector)         · entities · summary)    shared entities,
                                               shared tags)
                  └─►  wiki_abstract ────►    same                ← for wiki_topic docs
                       (chapter summary +
                        entities)
```

### Project layout

```
smart-note/
├── cloud/
│   ├── api/                  # FastAPI app — REST + MCP
│   │   ├── app/
│   │   │   ├── routers/      # documents, memories, notes, preferences, …
│   │   │   ├── services/     # processing_runs, enrich, kb, embedding, …
│   │   │   ├── contexts/     # knowledge, storage event subscriptions
│   │   │   └── mcp_http.py   # MCP streamable-HTTP server
│   │   └── scripts/          # backfills + one-shot maintenance
│   ├── mcp/                  # MCP server
│   ├── migrations/           # 0NN_*.sql, idempotent, run on startup
│   ├── infra/                # docker-compose.yml + Caddy + .env
│   ├── sdk-py/               # Python SDK
│   └── sdk-ts/               # TypeScript SDK
├── local_embedding/          # self-hosted embedding service
├── scripts/                  # restart-cloud / issue-apikey / clean-all-data
└── docs/
```

---

## ⚙️ Configuration

<details>
<summary><strong>Cloud-side LLM provider</strong></summary>

The cloud needs an OpenAI-compatible LLM to power enrichment (chunk_enrich), wiki abstracts, and the MCP classifier. It speaks `/chat/completions`. Recommended:

- **Budget**: `deepseek-chat` at `https://api.deepseek.com/v1`
- **Quality**: `gpt-4o-mini` at `https://api.openai.com/v1`
- **Reasoner**: `deepseek-reasoner`

Set it from an MCP-connected agent: call `set_enrich_provider(api_key=…, base_url=…, model=…)`. Without it, enrichment jobs stay disabled. The provider config is stored per-workspace in Postgres (`memories`, kind=preference).
</details>

<details>
<summary><strong>Useful commands</strong></summary>

```bash
./scripts/restart-cloud.sh                            # rebuild + restart api (the right way)
cd cloud/infra && docker compose logs -f api          # tail live logs
cd cloud/infra && docker compose exec postgres psql -U smartnote -d smartnote   # SQL shell

./scripts/clean-all-data.sh                           # wipe Postgres + restart cloud
./scripts/issue-cloud-apikey.sh                       # mint a new workspace key
```
</details>

<details>
<summary><strong>Migrations</strong></summary>

The cloud auto-runs SQL files from `cloud/migrations/` at startup in lexical order. Conventions:

- Filename: `0NN_short_name.sql`
- Every statement must be idempotent (`CREATE … IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`)
- No migration ledger by design — keep them re-runnable

After adding a migration, `./scripts/restart-cloud.sh` picks it up on the next build.
</details>

<details>
<summary><strong>Deployment</strong></summary>

`cloud/infra/` holds the compose files and a Caddy reverse proxy for production. See `cloud/infra/DEPLOY.md` for the production / LAN / shared-Postgres overrides (`docker-compose.prod.yml`, `docker-compose.lan.yml`, `docker-compose.shared.yml`).
</details>

---

## 🛟 Troubleshooting

<details>
<summary><strong>MCP client / SDK gets a 401</strong></summary>

The bearer key is invalid or was wiped (you ran `clean-all-data.sh`). Mint a new one with `./scripts/issue-cloud-apikey.sh` and update your client config. Verify a key against the REST API:

```bash
curl -X POST http://localhost:58000/v1/auth/token \
  -H "Content-Type: application/json" \
  -d '{"api_key": "sn_live_…"}'
# expect: {"jwt": "...", "expires_at": …}
```
</details>

<details>
<summary><strong>Restart didn't pick up my cloud code change</strong></summary>

`docker compose restart api` does **not** rebuild the image. The cloud has no live-mount; code is baked at build time.

Use `./scripts/restart-cloud.sh` (which runs `docker compose up -d --build api`).
</details>

<details>
<summary><strong>Enrichment jobs won't run</strong></summary>

The cloud LLM provider isn't set. From an MCP-connected agent, call `set_enrich_provider(api_key=…, base_url=…, model=…)`.
</details>

<details>
<summary><strong>"Provider returned no text"</strong></summary>

You're using a reasoner model (DeepSeek-Reasoner / o1) and it spent the entire token budget on hidden chain-of-thought. Switch to `deepseek-chat` / `gpt-4o-mini`, or allow a larger `max_tokens`.
</details>

---

## 🗺 Roadmap

- [ ] Auto-enrich after ingest (currently manual to control LLM spend)
- [ ] Multi-workspace tooling
- [ ] OAuth for shared workspaces

---

## License

MIT — see [LICENSE](LICENSE).

## Contributing

Issues and PRs at <https://github.com/TIZ36/smart-note>. For substantial changes, open an issue first to align on scope.
