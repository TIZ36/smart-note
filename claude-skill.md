# SmartNote MCP · Claude Code Guide

**Read this if you are Claude Code running inside the SmartNote repo, or if the user has SmartNote installed and wants you to consult their personal knowledge base.**

SmartNote is a local personal knowledge base. It exposes an MCP server that lets you search the user's notes, read evidence, track enrichment tasks, and curate wiki topics. When the user asks a question that might be answered by their own notes — search first, answer second, cite always.

## Configure MCP in Claude Code

The repo can expose SmartNote via project-scoped MCP config in `.mcp.json` (project root):

```json
{
  "mcpServers": {
    "smartnote": {
      "command": "server/.venv/bin/python",
      "args": ["server/mcp_server.py"],
      "env": {}
    }
  }
}
```

Claude Code picks this up automatically when the working directory is this repo. For use outside the repo, add it with CLI:

```bash
claude mcp add --transport stdio --scope user smartnote \
  -- /absolute/path/to/routinework/server/.venv/bin/python \
     /absolute/path/to/routinework/server/mcp_server.py
```

For a shared repo setup, use `--scope project` so Claude writes `.mcp.json` for the team.

Prerequisites — run once in the SmartNote repo:

```bash
./scripts/restart-server.sh
```

This creates `.venv`, installs dependencies, and migrates the DB.

Verify with:

```bash
claude mcp list
```

Inside Claude Code you can also run `/mcp` to view status/auth.

## Tool routing

| User intent | Tool to reach for |
|-------------|-------------------|
| "What do I know about X?" | `search_knowledge` → `read_source` for cited chunks |
| "Show me my TODOs" / "my work notes on Y" | `get_tag_segments("todo")` or `search_knowledge` with `tag_filter` |
| "What have I learned about topic Z?" | `find_wiki_topics` → `read_wiki_source` |
| "Remind me of my decisions on A" | `get_search_history` or `read_meta_memory` |
| "Import this URL/doc into my wiki" | `import_wiki_doc` or `update_wiki_doc` |
| "What's the state of my KB?" | `get_dashboard` |
| "Are there conflicts or duplicates?" | `list_conflicts`, `find_duplicate_wiki_sources` |

## Core workflow: answer with evidence

1. **Search.** `search_knowledge(query, top_k=10, tag_filter=...)` returns ranked segments with `source_ref`.
2. **Read evidence.** For each relevant hit, call `read_source(source_ref)` to get the full chunk before quoting.
3. **Cite.** In your answer, reference the `source_ref` so the user can jump to the line.
4. **Never fabricate.** If search returns nothing useful, say so — don't invent content that "sounds like" what the user wrote.

## Wiki curation workflow

When the user is reorganizing their knowledge:

1. `list_wiki_topics()` / `list_wiki_groups()` — see current structure
2. `find_duplicate_wiki_sources()` — detect redundancy
3. `dedupe_wiki_sources(actions=..., dry_run=True)` — preview merges before applying
4. `suggest_wiki_groups()` — get structural suggestions
5. `wiki_reorganize(groups=..., dry_run=False)` — commit the new layout

**Always run destructive wiki operations with `dry_run=True` first** and show the preview to the user.

## Memory and learning

- `read_meta_memory(limit=100)` — what the user has told you to remember across sessions
- `append_meta_memory(text, kind="rule", scope="global")` — persist a new rule the user stated
- `forget_meta_memory(memory_id)` — remove a stale rule
- `list_pending_enrichments()` / `submit_enrichments(...)` — help classify segments the system couldn't auto-tag

## Enrichment workflow (full note classification)

When `ingest_notes(reset=True, delegate_enrich=True)` completes, call
`list_pending_enrichments(kind='note_segments')` and follow this pattern:

### Dynamic subagent concurrency — 500 lines per agent

```
total_lines = build["total_lines"]
n_agents    = max(1, ceil(total_lines / 500))   # e.g. 6276 → 13 agents
```

Do NOT use the server's `suggested_partitions` (those are 3 fixed buckets).
Compute your own equal-sized partitions of ~500 lines and spawn one background
subagent per partition, all in a single message so they run in parallel.

Each subagent must:
1. Read its line range from `source_file`
2. Classify into segments (5–50 lines each, same-theme grouping)
3. Write JSONL to `/tmp/seg-{idx}.jsonl`
4. Report segment count + tag distribution

After all agents complete:
```bash
cat /tmp/seg-*.jsonl > /tmp/seg-all.jsonl
```
Then `submit_enrichments(kind='note_segments', items_file='/tmp/seg-all.jsonl', enriched_by='<your-cli-name>')`.

**Always pass `enriched_by` with your CLI name** — e.g. `"claude-code"`, `"cursor"`, `"opencode"`, `"gemini-cli"`. This is recorded in the build and shown in the SmartNote UI so the user can see which agent did the enrichment.

Tags: `work` · `learn` · `todo` · `daily_life` · `reminder` · `hobby` · `password` · `others`

Segment rules:
- Group consecutive same-theme lines → one segment (5–50 lines typical)
- Every line in the partition must be covered
- `password` for API keys, tokens, credentials — separate these from surrounding work content
- `line_start` / `line_end` are 1-based inclusive

### Build completion check

After submit, verify with:
```bash
sqlite3 <db_path> "SELECT COUNT(*) FROM chunks WHERE build_id='<id>' AND (dimension='' OR dimension IS NULL);"
```
Should be 0. If not, the leftover chunks fell into a gap — submit a covering segment for those exact lines.

The build flips to `completed` automatically once all chunk dimensions are filled.

## Ingestion and maintenance

- `ingest_notes(reset=False, delegate_enrich=True)` — incremental ingest (or full rebuild with `reset=True`)
- `process_pending_ocr(limit=20)` — run OCR on queued PDF/image imports
- `redistill_wiki(topic_name)` — regenerate a wiki topic from its current sources
- `list_knowledge_gaps(limit=20)` — entities referenced but never explained
- `list_split_suggestions()` — overgrown sections that want splitting

## Conflict resolution

When `list_conflicts()` returns entries, surface them to the user with both sides and call `resolve_conflict(conflict_id, choice)` with their decision. **Never silently pick a side.**

## Rules for Claude Code

1. **Search before answer** when the user's question could plausibly be in their notes.
2. **Cite with `source_ref`** in every answer that draws from retrieved content.
3. **`dry_run=True` first** for any tool that modifies wiki structure or note content.
4. **Respect meta-memory.** Read it at session start when the task touches the user's long-standing preferences.
5. **Don't ingest on every chat.** `ingest_notes` is user-initiated. Only call it when the user explicitly asks.
