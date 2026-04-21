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

## Note views (lenses over a single raw file)

SmartNote splits the Note page sidebar into two groups:

- **Enrich-tags** — AI classifier taxonomy. Adding a tag here changes what the next `ingest_notes(delegate_enrich=True)` pass classifies into.
- **Self-views** — user-owned lenses over a single raw file. Members are anchored by `line_hash` so they survive edits. Sources: `rule` (keyword/regex), `ai` (semantic match via retrieval), `manual` (hand-picked). Manual state always wins.

### Enrich-tag tools

- `list_tags()` — current taxonomy
- `add_enrich_tag(name, desc="")` — add a new bucket
- `delete_enrich_tag(name)` — remove a bucket (confirm with user first)
- `get_tag_segments(tag_name)` — segments under a tag

### Self-view tools

- `list_note_views(raw_path)` — list views + rules for a file
- `create_note_view(raw_path, name, keywords?, regex?, ai_query?, populate=True)` — create + populate in one call
- `update_note_view(view_id, name?, keywords?, regex?, ai_query?)` — rule fields replace atomically (pass all you want to keep)
- `delete_note_view(view_id)` — remove lens (source file untouched)
- `populate_note_view(view_id, replace=True)` — rerun rules + AI; manual state preserved
- `add_note_view_members(view_id, lines=[...])` — manually add by raw line text
- `remove_note_view_members(view_id, lines=[...])` — mark as excluded (survives future populates)
- `list_note_view_members(view_id, raw_path=?)` — resolve to live line numbers

### Patterns

**User asks to group content by topic:**
```
create_note_view(raw_path, name="<topic>", ai_query="<topic + synonyms>", populate=True)
list_note_view_members(view_id)    # verify with user
```

**User refines the view:**
```
add_note_view_members(view_id, lines=[...])     # missing rows
remove_note_view_members(view_id, lines=[...])  # unwanted rows — uses exclude
update_note_view(view_id, ai_query="refined query")
populate_note_view(view_id, replace=True)
```

### Guarantees

- File saves auto-repopulate every view additively — don't call `populate_note_view` after every save.
- Manual adds and exclusions are never overwritten by rule/ai populate.
- Auto-views for enrich-tags are read-only; don't try to add/remove members — manage the tag taxonomy instead.

## Rules for Cursor

1. **Search before answer** when the user's question could live in their KB.
2. **Cite `source_ref`** in every answer drawn from retrieved content.
3. **`dry_run=True` first** on any tool that modifies wiki structure.
4. **Don't auto-ingest.** `ingest_notes` runs only when the user explicitly asks.
5. **Respect `tag_filter`.** If the user scopes their question, scope your search.
6. **Resolve conflicts explicitly.** If `list_conflicts()` returns entries, present choices and ask the user which side to keep.
