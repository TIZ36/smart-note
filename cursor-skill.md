# SmartNote MCP · Cursor Guide

**Read this if you are Cursor and the user has SmartNote installed.**

SmartNote is a local personal knowledge base exposing an MCP server. Use its tools to answer questions from the user's own notes, pull cited evidence, and update their wiki. When a question could plausibly be answered from the user's KB — search first, answer second, cite always.

## Configure MCP in Cursor

Add SmartNote to Cursor MCP config (`~/.cursor/mcp.json` for user-level, or workspace `.cursor/mcp.json` for project-level):

```json
{
  "mcpServers": {
    "smartnote": {
      "command": "/absolute/path/to/routinework/server/.venv/bin/python",
      "args": ["/absolute/path/to/routinework/server/mcp_server.py"]
    }
  }
}
```

Use absolute paths. Cursor launches MCP processes from its own runtime context, so relative paths can fail.

Prerequisites — in the SmartNote repo:

```bash
./scripts/restart-server.sh
```

This bootstraps `.venv`, installs dependencies, and migrates SQLite schema.

Restart Cursor after editing config. Confirm `smartnote` is healthy in Cursor's MCP tools panel.

## Tool surface

### Answering questions

- `search_knowledge(query, top_k=10, tag_filter=None)` — 6-path hybrid search, returns ranked segments with `source_ref`
- `read_source(source_ref)` — full chunk for a source reference
- `get_tag_segments(tag_name)` — all segments for a given tag (`todo`, `work`, `learn`, …)
- `list_tags()` — available tags

### Wiki

- `find_wiki_topics(query, top_k=5)` — locate topics by name or content
- `read_wiki_source(topic_name)` — read the full topic document
- `list_wiki_topics()` / `list_wiki_groups()` — inventory
- `import_wiki_doc(...)` / `update_wiki_doc(topic_name, content, delegate_enrich=True)` — add or update

### Memory

- `read_meta_memory(limit=100)` — session-spanning rules the user has set
- `append_meta_memory(text, kind="rule", scope="global")` — record a new rule
- `forget_meta_memory(memory_id)` — drop a stale rule

### Hygiene

- `list_conflicts()` / `resolve_conflict(conflict_id, choice)` — contradictions between notes
- `find_duplicate_wiki_sources()` / `dedupe_wiki_sources(actions, dry_run=True)` — duplicate cleanup
- `get_dashboard()` — KB health snapshot
- `list_knowledge_gaps(limit=20)` — entities mentioned but never defined

### Ingestion (user-initiated only)

- `ingest_notes(reset=False, delegate_enrich=True)` — incremental
- `process_pending_ocr(limit=20)` — run OCR on queued PDFs

## Usage patterns

### Answer from the user's notes

```
search_knowledge(query="...", top_k=10)
  → for each relevant hit:
      read_source(source_ref=hit.source_ref)
  → compose answer citing source_refs
```

Never paraphrase retrieved content as if it were your own knowledge. Quote or attribute.

### Scoped recall

If the user says "in my work notes" or "my learning on React":
- Use `tag_filter="work"` or `tag_filter="learn"` in `search_knowledge`
- Or call `get_tag_segments(tag_name)` directly

### Wiki lookup

If the user names a topic ("what does my wiki say about rerankers?"):
- `find_wiki_topics(query="reranker")` → identifies the topic
- `read_wiki_source(topic_name=...)` → full content
- Cite the topic name in your answer

### Destructive operations

Any tool that modifies structure runs with `dry_run=True` first:
- `dedupe_wiki_sources(actions=..., dry_run=True)` → show preview → user approves → rerun with `dry_run=False`
- Same for `flatten_wiki_layout`, `wiki_reorganize`

### Meta-memory

At the start of a session where the task involves the user's preferences or long-standing rules:
- `read_meta_memory(limit=100)` once
- Apply the rules silently; don't recite them back

When the user states a durable preference ("always prefer X over Y"):
- `append_meta_memory(text="prefer X over Y because ...", kind="rule", scope="global")`

## Rules for Cursor

1. **Search before answer** when the user's question could live in their KB.
2. **Cite `source_ref`** in every answer drawn from retrieved content.
3. **`dry_run=True` first** on any tool that modifies wiki structure.
4. **Don't auto-ingest.** `ingest_notes` runs only when the user explicitly asks.
5. **Respect `tag_filter`.** If the user scopes their question, scope your search.
6. **Resolve conflicts explicitly.** If `list_conflicts()` returns entries, present choices and ask the user which side to keep.
