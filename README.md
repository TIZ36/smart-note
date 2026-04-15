# SmartNote

A local-first personal knowledge base with AI-powered search, tag classification, and adaptive retrieval.

Turn messy raw notes into a structured, searchable knowledge system — with a 4-stage RAG pipeline that learns from your feedback.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  Electron Desktop App (React + Tailwind)             │
├─────────────────────────────────────────────────────┤
│  Python FastAPI Backend (port 8787)                  │
│  ├── Ingestion: chunking + jieba + AI tag classify   │
│  ├── Search: 6-path recall → rerank → AI answer      │
│  ├── Memory: Q&A learning + adaptive weights          │
│  └── Storage: SQLite + FTS5                           │
├─────────────────────────────────────────────────────┤
│  MCP Server (Claude Code integration)                │
└─────────────────────────────────────────────────────┘
```

## Quick Start

### Prerequisites

- Python 3.11+
- Node.js 18+
- Docker (optional, for local embedding service)

### 1. Start Everything

```bash
./scripts/restart-all.sh --with-docker
```

This runs Docker embedding + backend + desktop client.

### 2. Or Start Individually

```bash
# Backend (creates venv, installs deps, migrates DB, starts server)
./scripts/restart-server.sh

# Desktop client (installs npm deps, starts Electron)
./scripts/restart-client.sh

# Docker embedding service (optional, for offline vector search)
./scripts/restart-docker.sh
```

### 3. Configure `.env`

```bash
cp server/.env.example server/.env
# Edit with your API key and preferences
```

**Recommended config with DeepSeek (cheapest, great for Chinese):**

```env
EMBEDDING_MODE=local

PROVIDER_BASE_URL=https://api.deepseek.com/v1
PROVIDER_API_KEY=sk-your-deepseek-key
PROVIDER_CHAT_MODEL=deepseek-chat

INGEST_AI_ENABLED=true
INGEST_CONCURRENCY=600
```

**Embedding mode comparison:**

| Mode | Speed | Quality | Cost | Requires |
|------|-------|---------|------|----------|
| `local` | Fast | Best | Free | Docker |
| `api` | Medium | Good | ~$0.02/1M tokens | API key |
| `mock` | Instant | No semantic search | Free | Nothing |

## Usage

### Ingest Notes

1. Open **Raw Input** in the sidebar
2. Set your raw file path (any `.md` or `.txt` file)
3. Click **Ingest** (incremental) or **Rebuild all** (full re-process)

### Search

1. Type a query in the search bar
2. 4-stage pipeline: **Recall** → **Rerank** → **AI Answer** → **Strengthen**
3. Press **Tab** to filter by tag
4. Upvote answers to train adaptive weights

### Tags

AI auto-classifies notes into: `learn`, `work`, `todo`, `daily_life`, `password`, `reminder`, `hobby`, `others`

## Scripts

| Script | Purpose |
|--------|---------|
| `scripts/restart-all.sh` | Start all services (with `--with-docker` for embedding) |
| `scripts/restart-server.sh` | Kill old → pip install → DB migrate → start backend |
| `scripts/restart-client.sh` | npm install → kill old → start Electron |
| `scripts/restart-docker.sh` | Docker compose for embedding service |
| `scripts/clean-data.sh` | Delete all data (DB, views, versions) |

## Tech Stack

- **Frontend**: React 19, Tailwind CSS 4, Framer Motion, CodeMirror 6, Electron
- **Backend**: Python, FastAPI, SQLite, FTS5, jieba
- **AI**: OpenAI-compatible API (configurable provider)
- **Search**: 6-path hybrid recall + embedding rerank + adaptive weights
- **MCP**: Bidirectional — expose as server + fetch from external servers

## Project Structure

```
.
├── server/                     # Python backend
│   ├── app/
│   │   ├── gateway.py          # FastAPI endpoints
│   │   ├── retrieval.py        # 6-path hybrid search
│   │   ├── rerank.py           # Embedding reranker
│   │   ├── ai_enrich.py        # AI tag classification
│   │   ├── adaptive.py         # Query profile learning
│   │   ├── memory.py           # Q&A memory system
│   │   ├── ingest.py           # Raw file ingestion pipeline
│   │   ├── knowledge_graph.py  # Entity graph
│   │   ├── rewrite.py          # Lossless reorganization
│   │   ├── db.py               # SQLite schema + migrations
│   │   ├── embed.py            # Embedding (mock/local/API)
│   │   └── cli.py              # CLI commands
│   ├── mcp_server.py           # MCP server for Claude Code
│   ├── requirements.txt
│   └── .env.example
├── desktop/                    # Electron + React frontend
│   ├── electron/               # Electron main process
│   ├── src/
│   │   ├── components/         # search, layout, ingest, settings, tags, wiki
│   │   ├── hooks/              # usePrefs, useHealth, useTags, useSearchState
│   │   └── lib/                # api.ts, types.ts, electron.ts
│   └── public/                 # App icons
├── embedding/                  # Docker embedding service
│   ├── Dockerfile
│   └── app.py
├── scripts/                    # Startup & maintenance scripts
├── docs/                       # Design documents
├── docker-compose.yml
└── sample/                     # Sample data for testing
```
