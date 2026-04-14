# IntelliNote

A local-first personal knowledge base with AI-powered search, tag classification, and adaptive retrieval.

Turn messy raw notes into a structured, searchable knowledge system — with a 4-stage RAG pipeline that learns from your feedback.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  Electron Desktop App (React + Tailwind)             │
├─────────────────────────────────────────────────────┤
│  Python FastAPI Backend (port 8787)                  │
│  ├── Ingestion: chunking + jieba + AI tag classify   │
│  ├── Search: 5-path recall → rerank → AI answer      │
│  ├── Memory: Q&A learning + adaptive weights          │
│  └── Storage: SQLite + FTS5                           │
└─────────────────────────────────────────────────────┘
```

## Quick Start

### Prerequisites

- Python 3.11+
- Node.js 18+
- Docker (optional, for local embedding service)

### 1. Setup Backend

```bash
cd mvp

# Create venv and install dependencies
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# Initialize database
python -m app.cli init-db

# Copy and configure .env
cp .env.example .env   # Edit with your API key and preferences
```

### 2. Start Docker Embedding Service (Recommended)

Local embedding gives you offline vector search without sending content to external APIs.

```bash
# Start the embedding service (runs sentence-transformers on port 8009)
./restart-docker.sh
```

> Requires Docker Desktop. First start downloads the model (~500MB), subsequent starts are fast.

### 3. Configure `.env`

```bash
cp .env.example .env
```

**Recommended config with DeepSeek (cheapest, great for Chinese):**

```env
EMBEDDING_MODE=local          # Use Docker embedding (recommended)

PROVIDER_BASE_URL=https://api.deepseek.com/v1
PROVIDER_API_KEY=sk-your-deepseek-key
PROVIDER_CHAT_MODEL=deepseek-chat

INGEST_AI_ENABLED=true
INGEST_CONCURRENCY=600
```

**Or with OpenAI ChatGPT:**

```env
EMBEDDING_MODE=local          # Use Docker embedding (recommended)

PROVIDER_BASE_URL=https://api.openai.com/v1
PROVIDER_API_KEY=sk-your-openai-key
PROVIDER_CHAT_MODEL=gpt-4o-mini

INGEST_AI_ENABLED=true
INGEST_CONCURRENCY=600
```

**Embedding mode comparison:**

| Mode | Speed | Quality | Cost | Requires |
|------|-------|---------|------|----------|
| `local` | Fast | Best | Free | Docker |
| `api` | Medium | Good | ~$0.02/1M tokens | API key |
| `mock` | Instant | No semantic search | Free | Nothing |

**LLM provider comparison (for chat + AI ingestion):**

| Provider | Model | Cost | Chinese | Speed |
|----------|-------|------|---------|-------|
| DeepSeek | `deepseek-chat` | ~¥1/1M tokens | Excellent | Fast |
| OpenAI | `gpt-4o-mini` | ~$0.15/1M tokens | Good | Fast |
| OpenAI | `gpt-4o` | ~$2.5/1M tokens | Good | Slower |

> DeepSeek is recommended for Chinese-heavy notes — best quality/cost ratio. Token cost is shown after each build in the version history.

### 4. Start Backend

```bash
./restart-server.sh
```

### 5. Start Desktop Client

```bash
./restart-client.sh
```

### Or use the all-in-one script:

```bash
./restart-all.sh --with-docker   # Recommended: Docker embedding + Backend + Client
```

## Usage

### Ingest Notes

1. Open **Raw Input** in the sidebar
2. Set your raw file path (any `.md` or `.txt` file with your notes)
3. Set the note output path
4. Click **Ingest** (incremental) or **Rebuild all** (full re-process)

The pipeline:
- **Parse** → extract chunks from raw file
- **Embed** → generate vector embeddings
- **Segment** → jieba Chinese word segmentation for FTS
- **AI Enrich** → classify line ranges into tags (learn, work, todo, password, etc.)
- **Store** → save chunks + tag segments to SQLite

### Search

1. Type a query in the search bar
2. The 4-stage pipeline runs:
   - **Recall**: 5 retrieval paths (FTS + LIKE + n-gram + vector + keyword)
   - **Rerank**: embedding cross-similarity scoring
   - **AI Answer**: LLM generates answer with `[1][2]` citations
   - **Strengthen**: upvote → saves Q&A memory for future searches
3. Press **Tab** to filter by tag (cycles: All → learn → work → ...)
4. Toggle **AI** on/off to save tokens
5. Click a source card to preview the original file
6. Ask follow-up questions in the conversation thread

### Tags

Tags are fixed categories that AI classifies your notes into:

| Tag | Content |
|-----|---------|
| `learn` | Study notes, tutorials, knowledge |
| `work` | Tasks, meetings, projects, bugs |
| `todo` | Action items, deadlines |
| `daily_life` | Personal, health, finance |
| `password` | API keys, tokens, credentials |
| `reminder` | Alerts, scheduled events |
| `hobby` | Entertainment, side projects |
| `others` | Uncategorized |

- Click a tag in the sidebar to browse its segments
- Each segment shows: line range, topic name, summary, keywords
- Click "View source" to see the original text
- Edit tags: click ✏️ to add, delete, or drag-reorder

### Version History

- Auto-created before each rebuild
- Shows token usage and cost (¥/USD)
- Click to expand details (tags, segments, token breakdown)
- Restore any previous version
- Delete old versions

### Settings

- **Appearance**: System / Light / Dark theme
- **Embedding**: mock (dev) / local (Docker) / api (OpenAI)
- **Provider**: Base URL, API key, models
- **AI Ingestion**: Enable/disable, choose model

## Scripts

| Script | Purpose |
|--------|---------|
| `restart-server.sh` | Kill old → pip install → DB migrate → start backend |
| `restart-client.sh` | npm install → kill old → start Electron |
| `restart-docker.sh` | Docker compose for embedding service |
| `restart-all.sh` | All of the above |

## Tech Stack

- **Frontend**: React 19, Tailwind CSS 4, Framer Motion, Lucide icons, Electron
- **Backend**: Python, FastAPI, SQLite, FTS5, jieba
- **AI**: OpenAI-compatible API (configurable provider)
- **Search**: 5-path hybrid recall + embedding rerank + adaptive weights

## Project Structure

```
mvp/
├── app/                    # Python backend
│   ├── gateway.py          # FastAPI endpoints
│   ├── retrieval.py        # 5-path hybrid search
│   ├── rerank.py           # Embedding reranker
│   ├── ai_enrich.py        # AI tag classification
│   ├── adaptive.py         # Query profile learning
│   ├── memory.py           # Q&A memory system
│   ├── tags.py             # Tag management
│   ├── ingest.py           # Raw file ingestion pipeline
│   ├── tokenizer.py        # jieba Chinese segmentation
│   ├── knowledge_graph.py  # Entity graph
│   ├── versioning.py       # KB version snapshots
│   ├── rewrite.py          # Lossless reorganization
│   ├── db.py               # SQLite schema + migrations
│   ├── config.py           # Settings from .env
│   ├── embed.py            # Embedding (mock/local/API)
│   ├── dimensions.py       # Fallback topic detection
│   └── cli.py              # CLI commands
├── desktop/                # Electron + React frontend
│   ├── electron/           # Electron main process
│   ├── src/
│   │   ├── App.tsx
│   │   ├── components/
│   │   │   ├── search/     # Search page, sources, answer
│   │   │   ├── layout/     # Sidebar, toast
│   │   │   ├── ingest/     # Raw input + versions
│   │   │   ├── settings/   # Settings panel
│   │   │   ├── tags/       # Tag view
│   │   │   ├── sync/       # Sync rate dashboard
│   │   │   └── rewrite/    # Lossless rewrite
│   │   ├── hooks/          # usePrefs, useHealth, useTags, useSearchState, useTheme
│   │   ├── lib/            # api.ts, types.ts, cn.ts, electron.ts
│   │   ├── index.css       # Design tokens (light + dark)
│   │   └── prototype.css   # Component styles (proto-*)
│   └── package.json
├── restart-*.sh            # Startup scripts
├── .env                    # Configuration
└── .impeccable.md          # Design context
```
