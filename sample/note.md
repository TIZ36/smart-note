# Welcome to SmartNote

This is your first note. SmartNote turns raw, messy input into a structured knowledge base you can search, link, and ask questions against. Edit or delete anything here — it's just a sample.

---

## How this works

1. **Capture** — paste anything into your raw note file (`raw.md`). TODOs, code snippets, meeting notes, passwords, random ideas. Structure doesn't matter.
2. **Ingest** — click **Ingest** in the Editor panel. SmartNote chunks your input, auto-classifies each segment (learn / work / todo / password / …), and indexes it with 6 retrieval paths.
3. **Search** — type any query. Results rank by FTS5 + vector + n-gram + keyword + tag metadata with adaptive weights that learn from your upvotes.
4. **Ask** — click **Ask AI** on any result for a cited answer that pulls evidence from your own notes.
5. **Import wiki** — paste a URL, fetch from Feishu/Notion via MCP, or drop a PDF. Everything becomes searchable Markdown.

Global hotkey: **⌃⇧N** appends clipboard to your raw file from anywhere.

---

## Todo

- [ ] Point SmartNote at your real raw note file — Settings → Raw path
- [ ] Set your LLM API key in `server/.env` (DeepSeek recommended for Chinese)
- [ ] Enable local embedding with Docker for free, offline vector search

#todo

---

## Work

### Ingestion pipeline (as it happens)

Raw segment → chunker → jieba tokenization → AI tag classifier → FTS5 index + vector embedding + keyword index. Each segment keeps a back-reference to `raw.md:line:N` so every search result is traceable.

Upvote an answer and its query weights feed back into the adaptive ranker. The more you use it, the better it ranks.

#work #learn

---

## Password

Example of how a credential segment looks (never committed to git, stored locally in SQLite):

```
example-service
  user: you@example.com
  note: replace this block with your own — this sample is safe to delete
```

#password

---

## Learn

### Hybrid retrieval — why 6 paths

Single-path retrieval fails on long queries, typos, and domain jargon. SmartNote combines:

- **FTS5** — exact word match with jieba Chinese segmentation
- **LIKE substring** — catches partial tokens FTS misses
- **N-gram overlap** — fuzzy match for typos and variants
- **Vector cosine** — semantic match via local or API embeddings
- **Keyword** — weighted domain-term match
- **Tag metadata** — filter by classification

Adaptive weight fusion combines all six. Upvotes shift weight toward whichever path contributed most to the good answer.

#learn

---

## Delete this note when you're ready

Once you connect your own raw file, this sample stops being useful. Feel free to wipe everything and start clean — your data, your notes.

#others
