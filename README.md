<p align="center">
  <img src="desktop/public/icon.svg" width="100" height="100" alt="SmartNote" />
</p>

<h1 align="center">SmartNote</h1>

<p align="center">
  Local-first personal knowledge base with AI-powered hybrid search.
  <br />
  Turn raw notes into a structured, searchable system — with a RAG pipeline that learns from your feedback.
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> &middot;
  <a href="#features">Features</a> &middot;
  <a href="#architecture">Architecture</a> &middot;
  <a href="#configuration">Configuration</a> &middot;
  <a href="#contributing">Contributing</a>
</p>

---

## Features

- **6-path hybrid search** — FTS5, substring, n-gram, vector, keyword, and tag metadata combined with adaptive weights
- **4-stage RAG pipeline** — Recall → Rerank → AI Answer → Strengthen (feedback loop)
- **AI tag classification** — auto-segments notes into learn, work, todo, password, etc.
- **Wiki / special knowledge** — import from URLs, MCP servers (Feishu/Notion), PDFs with OCR
- **Knowledge graph** — entity extraction + co-occurrence visualization
- **Lossless reorganization** — AI rewrites with dual-search A/B validation before approval
- **Adaptive learning** — upvotes train query weights; the system gets better as you use it
- **MCP integration** — bidirectional: expose your KB to Claude Code, fetch docs from external servers
- **Local-first** — all data in SQLite + Markdown files, syncs via iCloud, no cloud dependency
- **Niho theme** — terminal/pixel aesthetic with starfield particles, neon logo, and custom cursors

## Quick Start

### Prerequisites

- Python 3.11+
- Node.js 18+
- Docker (optional, for local embedding)

### One command

```bash
git clone https://github.com/TIZ36/smart-note.git
cd smart-note
cp server/.env.example server/.env   # add your API key
./scripts/restart-all.sh --with-docker
```

### Or start services individually

```bash
./scripts/restart-server.sh    # Python backend (venv + deps + DB migrate)
./scripts/restart-client.sh    # Electron desktop app
./scripts/restart-docker.sh    # Local embedding service (optional)
```

## Architecture

```
┌──────────────────────────────────────────────┐
│  Electron Desktop App                         │
│  React 19 · Tailwind CSS 4 · CodeMirror 6    │
├──────────────────────────────────────────────┤
│  Python FastAPI Backend (:8787)               │
│                                               │
│  Ingestion    chunking + jieba + AI classify  │
│  Search       6-path recall → rerank → answer │
│  Memory       Q&A learning + adaptive weights │
│  Storage      SQLite + FTS5                   │
├──────────────────────────────────────────────┤
│  MCP Server                                   │
│  Expose KB to Claude Code / fetch from Feishu │
└──────────────────────────────────────────────┘
```

### Search Pipeline

```
Query
  │
  ├─ FTS5 (jieba Chinese segmentation)
  ├─ LIKE substring
  ├─ N-gram overlap
  ├─ Vector cosine (local or API embeddings)
  ├─ Keyword match
  └─ Tag metadata
  │
  ▼
Adaptive weight fusion  →  Rerank (embedding similarity)  →  AI Answer  →  Feedback (+1)
                                                                              │
                                                              Updates weights for next query
```

## Configuration

```bash
cp server/.env.example server/.env
```

### LLM Provider

SmartNote works with any OpenAI-compatible API:

| Provider | Model | Cost | Chinese |
|----------|-------|------|---------|
| DeepSeek | `deepseek-chat` | ~¥1/1M tokens | Excellent |
| OpenAI | `gpt-4o-mini` | ~$0.15/1M tokens | Good |

```env
PROVIDER_BASE_URL=https://api.deepseek.com/v1
PROVIDER_API_KEY=sk-your-key
PROVIDER_CHAT_MODEL=deepseek-chat
INGEST_AI_ENABLED=true
```

### Embedding

| Mode | Quality | Cost | Requires |
|------|---------|------|----------|
| `local` | Best | Free | Docker |
| `api` | Good | ~$0.02/1M tokens | API key |
| `mock` | None (FTS only) | Free | Nothing |

```env
EMBEDDING_MODE=local
```

### Wiki Sources

Imported documents (URL, MCP, PDF) are stored as Markdown:

```env
# Default: iCloud Drive (synced across devices)
WIKI_SOURCES_DIR=~/Library/Mobile Documents/com~apple~CloudDocs/sn/source
```

## Usage

### Ingest Notes

1. Open **Editor** in the sidebar
2. Choose your raw note file (`.md` or `.txt`)
3. Click **Ingest** (incremental) or **Rebuild all**

### Search

1. Type a query — 6-path hybrid search runs automatically
2. Press **Tab** to cycle tag filters
3. Type `@topic` to scope to a wiki topic
4. Click **Ask AI** for a cited answer
5. Upvote good answers to train adaptive weights

### Import Wiki

- **URL**: paste any web page URL → converted to Markdown
- **MCP**: fetch docs from Feishu, Notion, or custom MCP servers
- **PDF**: auto-converts via MarkItDown / pdfplumber / OCR

### Tags

AI auto-classifies note segments:

`learn` · `work` · `todo` · `daily_life` · `password` · `reminder` · `hobby` · `others`

Custom tags can be added, reordered, and color-coded.

## Project Structure

```
.
├── server/                     Python backend
│   ├── app/
│   │   ├── gateway.py          FastAPI routes
│   │   ├── retrieval.py        6-path hybrid search
│   │   ├── rerank.py           Embedding reranker
│   │   ├── ai_enrich.py        AI tag classification
│   │   ├── adaptive.py         Query weight learning
│   │   ├── memory.py           Q&A memory system
│   │   ├── ingest.py           Ingestion pipeline
│   │   ├── knowledge_graph.py  Entity graph
│   │   ├── rewrite.py          Lossless reorganization
│   │   ├── db.py               SQLite + FTS5 + migrations
│   │   └── embed.py            Embedding (mock/local/API)
│   ├── mcp_server.py           MCP server for Claude Code
│   ├── requirements.txt
│   └── .env.example
├── desktop/                    Electron + React frontend
│   ├── electron/               Main process + preload
│   ├── src/
│   │   ├── components/         UI components
│   │   ├── hooks/              React hooks
│   │   └── lib/                API client, types
│   └── public/                 Icons
├── local_embedding/            Docker embedding service
├── scripts/                    Startup & maintenance
├── sample/                     First-run onboarding note
├── docs/                       Design documents
├── claude-skill.md             Claude Code MCP guide
├── cursor-skill.md             Cursor MCP guide
├── opencode-skill.md           OpenCode MCP guide
└── docker-compose.yml
```

## Scripts

| Script | What it does |
|--------|-------------|
| `scripts/restart-all.sh` | Start everything (`--with-docker` for embedding) |
| `scripts/restart-server.sh` | Backend: venv → deps (hash-skipped) → DB migrate → serve |
| `scripts/restart-client.sh` | Desktop: npm (hash-skipped) → Electron |
| `scripts/restart-docker.sh` | Docker embedding service (model pre-baked into image) |
| `scripts/install-pdf-support.sh` | Optional PDF / OCR deps (~250 MB extra) |
| `scripts/clean-data.sh` | Reset all data (DB, views, versions) |

### Dependency tiers

| Tier | Weight | Installed by | When needed |
|------|--------|--------------|-------------|
| Core (`requirements.txt`) | ~80 MB | `restart-server.sh` | Always — FastAPI, numpy, jieba, MCP |
| Optional (`requirements-optional.txt`) | ~250 MB | `install-pdf-support.sh` | PDF import, URL → Markdown, OCR |
| Embedding model | ~90 MB model + ~2 GB torch | Docker image (baked at build) | Local vector embeddings |

Restart scripts skip `pip install` / `npm install` when `requirements.txt` / `package-lock.json` hashes are unchanged — typical hot restart is 1–2 seconds end-to-end.

## Tech Stack

| Layer | Technologies |
|-------|-------------|
| Frontend | React 19, Tailwind CSS 4, Framer Motion, CodeMirror 6, Electron |
| Backend | Python 3.11+, FastAPI, SQLite, FTS5, jieba |
| AI | Any OpenAI-compatible API (DeepSeek, OpenAI, etc.) |
| Embedding | sentence-transformers (Docker) or API |
| Search | 6-path hybrid recall + embedding rerank + adaptive weights |
| MCP | Bidirectional — server (expose KB) + client (fetch docs) |

## Contributing

Contributions are welcome. Please open an issue first to discuss what you'd like to change.

```bash
# Development setup
./scripts/restart-server.sh     # backend on :8787
./scripts/restart-client.sh     # Electron + Vite HMR on :1420
```

## Roadmap

Phased by "stabilize first, then extend, then scale." Each phase is ~2–4 weeks of focused work.

### Phase 1 · Foundations (P0)

Lock down what's already designed before adding more.

- **Retrieval golden-set tests** — ~50 curated queries with expected evidence ids; pytest measures Recall@3 / MRR; CI gate
- **Structured logging with `request_id`** — per-query path scores, selected evidence, latency breakdown streamed as JSONL alongside `query_logs` / `answer_logs`
- **Read/write SQLite split** — `/search` on read-only connection, `/ingest` and `/feedback` on write connection; connection pool sized for concurrency
- **Async feedback processing** — `/feedback` only writes `feedback_logs`; a background worker handles memory distillation and adaptive-weight updates
- **Normalize `query_profile` keys** — lowercase + strip punctuation + jieba-normalize before keying; merge near-duplicate profiles

### Phase 2 · Retrieval Intelligence (P1)

Put the feedback signal to real work.

- **Learned reranker** — treat `+1` / click history as preference pairs; train a small cross-encoder (or LoRA-tune `bge-reranker`) to replace the LLM rerank call
- **Memory as a 7th recall path** — graduate memory from boost layer to full recall participant; its weight also enters adaptive fusion
- **Knowledge-graph retrieval path** — entities + relations are already extracted; add "entity → neighborhood expansion → back-link to text evidence" as a recall path
- **Cross-query generalization** — cluster `query_profiles` by embedding; share learned weights across the cluster to warm-start new queries

### Phase 3 · Agentic & Skill (P1)

Shift from passive KB to proactive assistant.

- **Skill Inspector** — parse external MCP server schemas, diff versions, surface dependency topology
- **Proactive suggestions** — dashboard surfaces signals from `search_misses`, `knowledge_gaps`, `split_suggestions` ("you've asked about X three times but it isn't in your KB — import?")
- **Scheduled redistill** — periodic scan of `wiki_topics`; auto-trigger `redistill_wiki` when sources have changed; backfill entities during idle windows

### Phase 4 · Multi-Device & Collaboration (P2)

Single-user desktop → multi-device and small teams.

- **CLI client** — reuses the MCP server tool surface; `smartnote search/ask/ingest` for terminal-native users
- **iOS consumer client** — read + capture only; writes via iCloud file drop, reads via HTTPS gateway
- **Multi-user backend** — SQLite → PostgreSQL + pgvector; per-user auth and isolation; shared embedding/LLM workers
- **Managed gateway** — move LLM routing, fallback, cost tracking, and token accounting into a hosted gateway layer

### Phase 5 · Commercialization (P2+)

- North-star metrics pipeline with retention and usage analytics
- Topic subscriptions — newsletter-style periodic digests of new evidence on watched topics
- Third-party MCP skill marketplace
- Enterprise tier — RBAC, audit logs, SSO

## License

MIT
