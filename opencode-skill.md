# SmartNote MCP · OpenCode Guide

**Read this if you are OpenCode and the user has SmartNote installed.**

SmartNote is a local personal knowledge base exposing an MCP server. Use its tools to answer from the user's own notes, pull cited evidence, and curate their wiki. When a question could plausibly be answered from the user's KB — search first, answer second, cite always.

## Configure MCP in OpenCode

OpenCode now configures MCP servers in `opencode.json` (or `opencode.jsonc`) under the `mcp` key.

Add SmartNote as a local MCP server:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "smartnote": {
      "type": "local",
      "command": [
        "/absolute/path/to/routinework/server/.venv/bin/python",
        "/absolute/path/to/routinework/server/mcp_server.py"
      ],
      "enabled": true,
      "timeout": 10000
    }
  }
}
```

Notes:

- Use absolute paths. OpenCode starts tools from its own runtime context; relative paths can fail.
- `command` is an array: executable first, then arguments.
- `environment` can be added if SmartNote needs extra env vars.
- `timeout` is optional; OpenCode defaults to 5000ms if omitted.

Prerequisites — in the SmartNote repo:

```bash
./scripts/restart-server.sh   # creates .venv, installs deps, migrates SQLite
```

Restart OpenCode after editing config. Verify SmartNote is registered with:

```bash
opencode mcp list
```

## Tool surface

### Answering questions

| Tool | Use for |
|------|---------|
| `search_knowledge(query, top_k=10, tag_filter=None)` | 6-path hybrid search; returns ranked segments with `source_ref` |
| `read_source(source_ref)` | Full chunk text for a given source reference |
| `get_tag_segments(tag_name)` | All segments tagged e.g. `todo`, `work`, `learn`, `password` |
| `list_tags()` | Inventory of available tags |
| `get_search_history()` | Recent queries (useful for "what was I looking at?") |

### Wiki

| Tool | Use for |
|------|---------|
| `find_wiki_topics(query, top_k=5)` | Locate a topic by name/content |
| `read_wiki_source(topic_name)` | Full topic document |
| `list_wiki_topics()` / `list_wiki_groups()` | Inventory / grouping |
| `import_wiki_doc(...)` | Add a new topic (from URL, MCP, PDF, or raw markdown) |
| `update_wiki_doc(topic_name, content, delegate_enrich=True)` | Overwrite topic content |
| `redistill_wiki(topic_name)` | Regenerate a topic from its current sources |

### Hygiene

| Tool | Use for |
|------|---------|
| `list_conflicts()` / `resolve_conflict(conflict_id, choice)` | Contradictions between notes |
| `find_duplicate_wiki_sources()` | Duplicate detection |
| `dedupe_wiki_sources(actions, dry_run=True)` | Merge duplicates (dry_run first) |
| `flatten_wiki_layout(topic_names, dry_run=True)` | Restructure wiki hierarchy |
| `wiki_reorganize(groups, dry_run=False)` | Apply a group reorganization |
| `list_split_suggestions()` | Overgrown sections wanting split |
| `get_dashboard()` | KB health snapshot |

### Memory

| Tool | Use for |
|------|---------|
| `read_meta_memory(limit=100)` | Durable rules the user has set across sessions |
| `append_meta_memory(text, kind, scope)` | Record a new rule |
| `forget_meta_memory(memory_id)` | Remove a stale rule |

### Ingestion (user-initiated)

| Tool | Use for |
|------|---------|
| `ingest_notes(reset=False, delegate_enrich=True)` | Incremental ingest; `reset=True` for full rebuild |
| `process_pending_ocr(limit=20)` | OCR on queued PDF/image imports |
| `list_pending_enrichments(...)` / `submit_enrichments(...)` | Classify segments the system couldn't auto-tag |
| `classify_segment(...)` | One-off classification |
| `append_to_note(content)` | Append content to note.md (respects versioning) |

### Graphs

| Tool | Use for |
|------|---------|
| `get_knowledge_graph()` | Entity + co-occurrence graph from segments |
| `get_wiki_graph()` | Topic linkage graph |

## Usage patterns

### Answer from the user's KB

```
hits = search_knowledge(query, top_k=10, tag_filter=<optional>)
for hit in relevant(hits):
    chunk = read_source(hit.source_ref)
compose_answer_with_citations(chunks)
```

Cite every claim drawn from retrieved content. If search returns nothing relevant, say so — don't hallucinate KB content.

### Wiki curation

```
list_wiki_groups()
find_duplicate_wiki_sources()
dedupe_wiki_sources(actions, dry_run=True)   # preview
<user approves>
dedupe_wiki_sources(actions, dry_run=False)  # commit
```

### Cross-session memory

```
# session start, if task involves long-standing preferences
rules = read_meta_memory(limit=100)
apply_rules_silently(rules)

# user states a durable preference
append_meta_memory(text="...", kind="rule", scope="global")
```

## Rules for OpenCode

1. **Search before answer** when the user's question could live in their KB.
2. **Cite `source_ref`** for every fact drawn from retrieved content.
3. **`dry_run=True` first** on any wiki-modifying tool; show preview and wait for confirmation.
4. **Don't auto-ingest.** `ingest_notes` runs only when the user asks.
5. **Respect scopes.** If the user says "in my work notes", set `tag_filter="work"`.
6. **Resolve conflicts explicitly.** Never silently choose a side when `list_conflicts()` returns hits.
