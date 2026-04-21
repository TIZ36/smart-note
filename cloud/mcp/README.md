# SmartNote Cloud — MCP bridge

An MCP server that lets **Claude Code / Cursor / OpenCode / any other
MCP-compatible agent** read and write your SmartNote Cloud memory,
preferences, and documents.

This is the fastest way to dogfood the cloud service — point your agent
at this server, it speaks MCP natively, no custom integration needed.

## What's exposed

| Tool | Purpose |
|------|---------|
| `search_memory(query, kinds?, topk?)` | Hybrid vector + lexical search over memories (pinned items always first) |
| `add_memory(content, kind, tags?, structured?, pinned?)` | Record a new memory |
| `list_memories(kind?, scope?, limit?)` | Browse memories, newest first |
| `get_memory(id)` | Full details of a single memory |
| `update_memory(id, content?, tags?, pinned?, ...)` | Partial update (re-embeds on content change) |
| `delete_memory(id)` | Delete permanently |
| `set_preference(key, value, description?)` | Durable user preference (supersedes prior value) |
| `get_preference(key)` / `list_preferences()` / `delete_preference(key)` | Preference CRUD |
| `add_document(name, content, ingest=true)` | Upload + chunk-and-embed a document |
| `list_documents()` | Inventory |
| `get_usage()` | Workspace usage counters |

Every tool runs against the workspace the API key is scoped to.

## Setup

Prereqs:
- Python 3.10+
- The SmartNote Cloud API running (see `cloud/README.md`) and an API key
  (`sn_live_…`). For local dev, `./cloud/scripts/quickstart.sh` gives
  you a workspace + key end-to-end.

Install:
```bash
cd cloud/mcp
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

Smoke-test:
```bash
SMARTNOTE_API_KEY=sn_live_... SMARTNOTE_BASE_URL=http://localhost:58000 \
  python server.py
# Should print "Running with transport 'stdio'" and wait.
# Ctrl-C to exit; a real MCP client connects over stdio.
```

## Wiring it into your agents

### Claude Code

Project-scoped config at `.mcp.json` in your repo root:

```json
{
  "mcpServers": {
    "smartnote-cloud": {
      "command": "/absolute/path/to/smartnote/cloud/mcp/.venv/bin/python",
      "args": ["/absolute/path/to/smartnote/cloud/mcp/server.py"],
      "env": {
        "SMARTNOTE_API_KEY": "sn_live_...",
        "SMARTNOTE_BASE_URL": "http://localhost:58000"
      }
    }
  }
}
```

Or user-scoped via CLI:

```bash
claude mcp add --transport stdio --scope user smartnote-cloud \
  --env SMARTNOTE_API_KEY=sn_live_... \
  --env SMARTNOTE_BASE_URL=http://localhost:58000 \
  -- /absolute/path/to/smartnote/cloud/mcp/.venv/bin/python \
     /absolute/path/to/smartnote/cloud/mcp/server.py
```

Verify with `claude mcp list` and `/mcp` inside Claude Code.

### Cursor

Add to `~/.cursor/mcp.json` (user-level) or `.cursor/mcp.json` in a
workspace:

```json
{
  "mcpServers": {
    "smartnote-cloud": {
      "command": "/absolute/path/to/smartnote/cloud/mcp/.venv/bin/python",
      "args": ["/absolute/path/to/smartnote/cloud/mcp/server.py"],
      "env": {
        "SMARTNOTE_API_KEY": "sn_live_...",
        "SMARTNOTE_BASE_URL": "http://localhost:58000"
      }
    }
  }
}
```

Restart Cursor; confirm `smartnote-cloud` is healthy in the MCP tools panel.

### OpenCode

In `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "smartnote-cloud": {
      "type": "local",
      "command": [
        "/absolute/path/to/smartnote/cloud/mcp/.venv/bin/python",
        "/absolute/path/to/smartnote/cloud/mcp/server.py"
      ],
      "enabled": true,
      "environment": {
        "SMARTNOTE_API_KEY": "sn_live_...",
        "SMARTNOTE_BASE_URL": "http://localhost:58000"
      }
    }
  }
}
```

Restart and verify with `opencode mcp list`.

## Environment variables

| Var | Default | Purpose |
|-----|---------|---------|
| `SMARTNOTE_API_KEY` | _(required)_ | Workspace-scoped API key from the console / dev-bootstrap |
| `SMARTNOTE_BASE_URL` | `http://localhost:58000` | Cloud API base URL — switch to your prod URL when you deploy |
| `SMARTNOTE_AGENT` | _(unset)_ | Optional label included in writes so you can tell which agent wrote which memory |

## Scopes

The minimum scopes this bridge needs on the API key:

- `memories:read`, `memories:write`
- `retrieve`
- `documents:read`, `documents:write`, `documents:ingest`

The `admin` scope covers all of these. For production, mint a scoped
key per agent via the console.

## Writing memories vs preferences

- **`set_preference`** for durable settings the user states directly
  ("reply in Chinese", "commit in English"). Supersedes keep the audit
  trail clean.
- **`add_memory(kind="fact")`** for stable truths about the user
  ("runs on macOS", "Python is primary language").
- **`add_memory(kind="episode")`** for "this happened" notes that might
  decay — e.g. session summaries.
- **`add_memory(kind="procedure")`** for multi-step workflows the user
  wants the agent to reuse.

When in doubt, add with `kind="fact"` and rely on `search_memory` to
surface the right piece later.
