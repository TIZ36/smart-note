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
├── embedding/                  Docker embedding service
├── scripts/                    Startup & maintenance
├── docs/                       Design documents
└── docker-compose.yml
```

## Scripts

| Script | What it does |
|--------|-------------|
| `scripts/restart-all.sh` | Start everything (`--with-docker` for embedding) |
| `scripts/restart-server.sh` | Backend: venv → deps → DB migrate → serve |
| `scripts/restart-client.sh` | Desktop: npm install → Electron |
| `scripts/restart-docker.sh` | Docker embedding service |
| `scripts/clean-data.sh` | Reset all data (DB, views, versions) |

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

## License

MIT
