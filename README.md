<p align="center">
  <img src="desktop/public/icon.svg" width="92" height="92" alt="SmartNote" />
</p>

<h1 align="center">SmartNote</h1>

<p align="center">
  Local-first personal knowledge workspace with cloud-side RAG and MCP integration.<br/>
  Notes live as Markdown on your disk; the cloud indexes them, runs LLM enrichment,
  and exposes them to AI agents (Claude Code · Cursor · Opencode) through MCP.
</p>

<p align="center">
  <a href="#1-quick-start">Quick Start</a> ·
  <a href="#2-ai-provider-setup">AI Provider</a> ·
  <a href="#3-architecture">Architecture</a> ·
  <a href="#4-daily-workflow">Daily Workflow</a> ·
  <a href="#5-troubleshooting">Troubleshooting</a>
</p>

---

## 1. Quick Start

You need both halves running:

| Half | What it is | Where it runs |
|---|---|---|
| **Cloud** | FastAPI + Postgres+pgvector + embeddings + MCP HTTP | Docker (single host) |
| **Desktop** | Electron client (note editor, library, KP, Spotlight) | Your laptop |

### 1.1 Cloud (5 min)

Bring up the full stack with one script. It builds Docker images, starts Postgres + the embedding service + the API, and runs an end-to-end smoke test.

```bash
git clone https://github.com/TIZ36/smart-note.git
cd smart-note
./cloud/scripts/quickstart.sh
```

What you get when this finishes:

- `http://localhost:58000` — REST API (`/v1/health` returns `200`)
- `http://localhost:58000/mcp` — MCP HTTP endpoint for AI agents
- `localhost:55432` — Postgres
- `http://localhost:58009` — local embedding service

Tear down:
```bash
cd cloud/infra && docker compose down       # stop
cd cloud/infra && docker compose down -v    # stop + wipe DB
```

> **First-run note**: the embed-model image download is the slow part (~3-5 min). Subsequent starts are seconds. The script waits up to 2 minutes for `/v1/health`; if it fails, run `cd cloud/infra && docker compose logs --tail 100 api`.

### 1.2 Issue a workspace API key

Before connecting the desktop, mint an API key for your workspace:

```bash
./cloud/scripts/issue_key.sh
```

You'll get a `wsk_…` token. Copy it — you'll paste it into the desktop in the next step.

### 1.3 Desktop (3 min)

```bash
cd desktop
npm install
npm run electron:dev
```

The Electron window opens. Now connect it to your cloud:

1. Click the **Cloud** icon on the left rail
2. **Connection** tab:
   - **Cloud URL**: `http://localhost:58000`
   - **Workspace API key**: paste the `wsk_…` token from step 1.2
   - **Sync enabled**: ✓
   - Click **Save connection**

Done. The desktop will sync notes to cloud on save.

### 1.4 Build a release (optional)

```bash
cd desktop
npm run electron:build      # produces a signed .app / .dmg in dist/
```

---

## 2. AI Provider Setup

There are **two** independent LLM configs — different jobs, different places to fill them in:

| Config | Location | Powers | Default |
|---|---|---|---|
| **Cloud AI provider** | Cloud panel → **AI provider** tab | Cloud-side enrich · wiki abstract · MCP-triggered classifier | OFF (no key) |
| **Local Chat provider** | Settings → Chat provider | Spotlight ⌘K AI Q&A · in-app rewrites | OFF (no key) |

Both speak the OpenAI-compatible `/chat/completions` API. Recommended:

- **Cost-conscious**: `deepseek-chat` ($0.14/M input, $0.28/M output) at `https://api.deepseek.com/v1`
- **Quality**: `gpt-4o-mini` at `https://api.openai.com/v1`
- **Reasoner**: `deepseek-reasoner` (you'll see a "💭 Thinking" stream in Spotlight)

### 2.1 Cloud AI provider — for enrich + wiki abstract

1. Open Cloud panel (left rail → cloud icon)
2. **AI provider** tab
3. Fill **Base URL**, **API key**, **Model** — e.g. `https://api.deepseek.com/v1`, `sk-…`, `deepseek-chat`
4. **Save provider**
5. Status dot turns green; the **AI provider** tab shows ✓ key set

Without this, the **Enrich** and **Build wiki-smartsheet** buttons on the KP page are disabled and `/v1/enrich/run` returns 412.

### 2.2 Local Chat provider — for AI Q&A

1. Open Settings (left rail → gear icon)
2. **Chat provider** card
3. Fill **Base URL** / **API key** / **Chat model**
4. Click **Save**

Used by:
- **⌘K Spotlight** → "✨ Compose answer from these N chunks" button
- Note editor AI rewrites (when AI features are on)

---

## 3. Architecture

```
┌─────────────── Desktop (Electron) ───────────────┐
│                                                  │
│  Note editor   Library  RAG/KP  Stream  Spotlight│
│       │           │       │       │        │     │
│       ▼           ▼       ▼       ▼        ▼     │
│  ┌──────────────────────────────────────────┐    │
│  │  cloud-api.ts  (HTTPS / WS to cloud)     │    │
│  └──────────────┬───────────────────────────┘    │
└─────────────────┼────────────────────────────────┘
                  │  ⌘K → separate frameless window
                  │
┌─────────────────▼────────── Cloud (FastAPI) ─────┐
│                                                  │
│  /v1/documents     /v1/chunks/search             │
│  /v1/enrich/run    /v1/processing/{id}/run       │
│  /v1/devices       /v1/device/relay (WS)         │
│  /mcp              ← Claude Code · Cursor · …    │
│                                                  │
│  ├── Postgres + pgvector (chunks, tag_segments,  │
│  │   wiki_chapters, entities, enrich_jobs, …)    │
│  ├── Embedding service (sentence-transformers)   │
│  └── LLM dispatcher (cloud_pool / mcp_pull /     │
│      ws_relay) → cloud-side OpenAI-compatible    │
└──────────────────────────────────────────────────┘
```

### Three document kinds (`metadata.smartnote_type`)

| Kind | Source | Indexing | LLM artifact |
|---|---|---|---|
| `note` | desktop edits | chunks (paragraph-split) | tag_segments |
| `wiki_topic` | imported `.md` files | chapters (H2-split) + chunks | wiki_chapters.summary |
| `doc` (default) | uncategorized | chunks | tag_segments |

### Three pipeline stages

`E → R → G` (visible as badges in KP and Library KN view):

| Letter | Note kind | Wiki kind |
|---|---|---|
| **E** | embed (chunks) | embed (chunks) |
| **R** | aisegment (line-range tags) | wiki-knowledge-sheet (per-chapter summary) |
| **G** | info-graph (entities + co-occurrence) | info-graph (entities from chapter abstracts) |

---

## 4. Daily Workflow

### 4.1 Save a note → searchable everywhere

1. Open a note in the editor (`Note` icon on rail)
2. Edit, ⌘S
3. Sync to Cloud is automatic if connected
4. Press ⌘K from anywhere → Spotlight panel pops up; type a query

### 4.2 Run knowledge processing

1. Click **RAG** icon on rail (KP page)
2. Pick sources (notes / wiki) on the left tree
3. Click **Embedding** (no LLM, free)
4. After E lights up, click **Enrich** (notes) or **Build wiki-smartsheet** (wiki) — these burn LLM tokens
5. Watch the live progress panel; click into Library KN view for per-doc detail (Pipeline · Chunks · Chapters/Tags · Enrich tabs)

### 4.3 Compose an AI answer

1. ⌘K → search query → Enter
2. See retrieval chunks grouped by note/wiki/doc
3. Click **✨ Compose answer** → streaming response with [N] citations
4. (DeepSeek-Reasoner / o1) → "💭 Thinking" block shows chain-of-thought first, then final answer

### 4.4 Connect AI agents via MCP

Cloud panel → **MCP** tab → pick **Claude Code / Cursor / Opencode** → copy the JSON snippet → paste into the agent's MCP config file (path shown in UI). Restart the agent.

The agent now has tools:
- `search_memory` — query your KB
- `add_document`, `add_memory` — write back
- `propose_memory` — submit a draft for your review
- `get_document`, `search_documents` — fetch full content
- `queue_enrich_jobs` — trigger cloud-side enrichment

---

## 5. Troubleshooting

### Cloud won't start / `/v1/health` 502

```bash
cd cloud/infra
docker compose logs --tail 200 api
```

Common causes:
- `cloud/infra/.env` missing → run quickstart again
- Embed image still downloading on first run → wait
- Port conflict on 58000 / 55432 / 58009 → edit `cloud/infra/.env`

### Desktop shows "Cloud not configured"

Cloud panel → Connection tab → check URL + API key are saved (key field shows "•••••••• (leave empty to keep)" after first save). Test via:
```bash
curl -H "Authorization: Bearer wsk_…" http://localhost:58000/v1/health
```

### Enrich / Build wiki-smartsheet button greyed out

Cloud AI provider not set. Cloud panel → AI provider tab → fill base_url + api_key + model → Save.

### Spotlight (⌘K) doesn't open

- Another macOS app may already grab ⌘K. Settings → Global hotkey → set a different binding (e.g. `CommandOrControl+Alt+Space`)
- Restart Electron fully (⌘Q, not ⌘W) to re-register the global accelerator

### "Provider returned no text"

Your chat provider is a reasoning model (DeepSeek-Reasoner / o1) and burned the entire token budget on hidden chain-of-thought. Either:
- Switch to a non-reasoner model (`deepseek-chat`, `gpt-4o-mini`)
- Or accept the longer wait — the IPC handler auto-bumps `max_tokens` to 4096 for reasoners

### DevTools (Electron)

The proto chrome hides the menu bar. Use:
- **⌘⌥I** or **F12** — toggle DevTools
- **⌘R** — reload renderer (handy when you see a white screen)

---

## 6. Advanced

### Project layout

```
smart-note/
├── cloud/
│   ├── api/          # FastAPI app (cloud/api/app/)
│   ├── infra/        # docker-compose + .env
│   ├── migrations/   # SQL migrations (run automatically on startup)
│   ├── scripts/      # quickstart.sh, demo.py, issue_key.sh
│   └── sdk-py, sdk-ts
├── desktop/
│   ├── electron/     # main.mjs, preload.cjs, services/
│   ├── public/       # icons
│   └── src/          # React renderer (App, components, lib, hooks)
└── docs/             # design + processing-pipeline references
```

### Where credentials live

| Credential | File | Notes |
|---|---|---|
| Cloud URL + workspace key | `~/Library/Application Support/desktop/cloud-creds.json` | per-user, chmod 600 |
| Local provider api_key | same file | never ships to renderer |
| Cloud-side enrich provider | Postgres `provider_config` table | per-workspace |

The desktop never reads any local Python gateway — that legacy service was retired. All persistence is electron IPC + cloud HTTP.

### Useful commands

```bash
# Cloud
cd cloud/infra && docker compose logs -f api      # live api logs
cd cloud/infra && docker compose restart api      # restart after backend changes
./cloud/scripts/quickstart.sh                     # full reset + smoke test

# Desktop
cd desktop && npm run dev                         # vite only (renderer hot-reload)
cd desktop && npm run electron:dev                # full electron + vite (typical)
cd desktop && npx tsc --noEmit                    # type-check
cd desktop && npm run electron:build              # produce .dmg / .app
```

### Schema migrations

Cloud auto-runs SQL migrations from `cloud/migrations/` at startup. To add one:
```
cloud/migrations/0NN_short_name.sql
```
Naming = ordering. The runner is idempotent.

---

## License

MIT — see [LICENSE](LICENSE).

## Contributing

Issues and PRs welcome at <https://github.com/TIZ36/smart-note>.
