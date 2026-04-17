# Architecture

Current system state. Last synced with code: 2026-04-17.

## Stack

| Layer | Choice | Notes |
|-------|--------|-------|
| Desktop shell | Electron + React 19 + TypeScript | Vite HMR, CodeMirror 6 editor |
| Styling | Tailwind CSS 4 + custom `proto-*` tokens | Terminal/pixel aesthetic (Niho theme) |
| Motion | Framer Motion | Short (120–220ms) transitions |
| Backend | Python 3.11+ FastAPI on `:8787` | Single process |
| Storage | SQLite + FTS5 | App-embedded, no external DB |
| Vectors | SQLite BLOB + numpy cosine | No separate vector DB |
| Embedding | Local Docker (`sentence-transformers`) or API | Mock fallback for FTS-only mode |
| LLM | Any OpenAI-compatible HTTP endpoint | Direct calls, no gateway library |
| MCP | Bidirectional: server exposes KB, client fetches docs | `server/mcp_server.py` + `app/mcp_client.py` |

## Process layout

```
┌─────────────────────────────────────────────────┐
│  Electron main + preload (desktop/electron/)    │
│  - global hotkey, file dialog, app lifecycle    │
├─────────────────────────────────────────────────┤
│  React renderer (desktop/src/)                  │
│  - editor, dashboard, settings, wiki inspector  │
│  - calls backend over HTTP                      │
├─────────────────────────────────────────────────┤
│  FastAPI backend (server/app/gateway.py)        │
│  - /ingest, /search, /ask, /wiki, /mcp, ...     │
├─────────────────────────────────────────────────┤
│  MCP server (server/mcp_server.py)              │
│  - stdio transport, exposes KB tools to Claude  │
└─────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────┐
│  SQLite file  (server/data/app.db)              │
│  FTS5 tables, vector BLOBs, logs, memories      │
└─────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────┐
│  iCloud Drive                                   │
│  raw.md · note.md · wiki/source/<topic>.md      │
└─────────────────────────────────────────────────┘
```

## Backend modules

| File | Responsibility |
|------|----------------|
| `gateway.py` | FastAPI routes, request validation, streaming SSE |
| `ingest.py` | Raw → chunks → classify → index |
| `retrieval.py` | 6-path hybrid recall |
| `rerank.py` | Embedding-based reranking |
| `adaptive.py` | Per-query weight learning from feedback |
| `memory.py` | High-value Q&A memory with retrieval boost |
| `ai_enrich.py` · `autoclassify.py` · `tags.py` | Tag classification pipeline |
| `knowledge_graph.py` | Entity + co-occurrence extraction |
| `rewrite.py` | Lossless reorganization with A/B validation |
| `versioning.py` | Snapshot + rollback for note.md |
| `mcp_client.py` · `mcp_import.py` | Fetch docs from external MCP servers |
| `url_import.py` · `pdf_convert.py` · `ocr.py` | Wiki import adapters |
| `wiki_dedup.py` | Duplicate detection and cleanup for wiki sources |
| `embed.py` · `quantize.py` | Vector generation and storage |
| `db.py` | Schema, migrations, connection pool |

## Data locations

- `server/data/app.db` — SQLite database (gitignored)
- `~/Library/Mobile Documents/com~apple~CloudDocs/sn/source/` — wiki sources (configurable via `WIKI_SOURCES_DIR`)
- User-chosen path — raw.md + derived note.md (set in Settings)

## Why these choices

**Electron, not Tauri.** Rapid iteration on UI with a JS-first team; startup and bundle size didn't block shipping.

**Direct OpenAI-compat calls, not LiteLLM.** One provider interface covers DeepSeek, OpenAI, and local Ollama. Adding a gateway library was unjustified overhead.

**SQLite BLOBs + numpy, not sqlite-vec.** Vector counts stay in the tens of thousands — cosine over numpy arrays is fast enough and avoids the native-binding burden.

**Tags, not `views/*.md`.** Classification attaches to segments; the UI filters by tag rather than materializing per-dimension files. Same result, fewer moving parts.

**Wiki, not `knpath.md`.** Wiki topics replace the originally planned `knpath.md` knowledge-path file — they're the same concept (curated, per-topic knowledge) with first-class UI and import support.
