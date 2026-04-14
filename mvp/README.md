# Smart Notes MVP

Minimal executable MVP for:

- raw file as source of truth (`txt/md/rtf` converted text)
- incremental `raw -> note.md` generation by dimensions
- local knowledge base (SQLite + FTS5 + vector score in app layer)
- query/answer/feedback logs and memory loop
- API-key mode and local embedding service mode
- Apple-style UI scaffold (`ui/`) for future Tauri integration

## Final Technical Decisions

- Desktop: macOS app later (Tauri), MVP backend now in Python.
- Storage: SQLite (MVP), Postgres + pgvector later.
- Retrieval: FTS + Vector + Memory (hybrid), not vector-only.
- Embedding:
  - Local mode: Python embedding service in Docker (`sentence-transformers`).
  - API mode: OpenAI-compatible `/embeddings`.
- Provider routing: API mode supports OpenAI-compatible config.

## Quick Start

1) Create env and install deps

```bash
cd mvp
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

2) Init database

```bash
python -m app.cli init-db
```

3) Run ingestion (example)

```bash
python -m app.cli ingest --raw ../sample/raw.md --note ../sample/note.md
```

4) Search

```bash
python -m app.cli search --query "今天有哪些需求"
```

5) Start API gateway

```bash
python -m app.cli serve --port 8787
```

6) Open UI prototype

```bash
open ./ui/index.html
```

## One-command helpers

- `./start_backend.sh`
- `./start_desktop.sh`
- `./start_all.sh`

## Local Embedding via Docker (optional)

```bash
docker compose -f docker-compose.embedding.yml up -d --build
```

Then set in `.env`:

```env
EMBEDDING_MODE=local
LOCAL_EMBED_ENDPOINT=http://localhost:8009/embed
```

## API-key mode

Set in `.env`:

```env
EMBEDDING_MODE=api
PROVIDER_BASE_URL=https://api.openai.com/v1
PROVIDER_API_KEY=your_key
PROVIDER_CHAT_MODEL=gpt-4o-mini
PROVIDER_EMBED_MODEL=text-embedding-3-small
```

## What this MVP already supports

- dimension views generation:
  - `views/todo.md`
  - `views/requirements.md`
  - `views/project-<slug>.md`
- logs:
  - `query_logs`
  - `answer_logs`
  - `feedback_logs` (`plus_one` supported)
- memory update from positive feedback

## Next (planned)

- integrate into Tauri shell
- add provider router (LiteLLM) in gateway
- add KG path (`kg_entities`, `kg_relations`) into retrieval fusion
