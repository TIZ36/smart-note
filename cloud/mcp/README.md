# SmartNote Cloud — MCP

The cloud API exposes MCP natively over HTTP at `/mcp`. Any MCP client
with streamable-HTTP support (Claude Code, Cursor, OpenCode recent
versions) can connect with just a URL + an `Authorization: Bearer` API
key. **No local install, no absolute paths, no spawned processes.**

This folder also ships a stdio-transport server for advanced users who
want to run SmartNote MCP offline or pre-load it into environments
without remote-MCP support. See the "stdio fallback" section at the
bottom.

## Get an API key

```bash
./cloud/scripts/issue_key.sh [workspace-name]
# → prints an sn_live_... secret exactly once; save it.
```

## What's exposed

| Tool | Purpose |
|------|---------|
| `search_memory(query, kinds?, topk?)` | Hybrid vector + lexical search over memories (pinned first) |
| `add_memory(content, kind, tags?, structured?, pinned?)` | Record a new memory |
| `list_memories(kind?, scope?, limit?)` | Browse memories, newest first |
| `get_memory(id)` | Full details of a single memory |
| `update_memory(id, content?, tags?, pinned?, ...)` | Partial update (re-embeds on content change) |
| `delete_memory(id)` | Delete permanently |
| `set_preference(key, value, description?)` | Durable user preference (supersedes prior value) |
| `get_preference(key)` / `list_preferences()` / `delete_preference(key)` | Preference CRUD |
| `add_document(name, content, ingest=true)` | Upload + chunk + embed |
| `list_documents()` | Inventory |
| `get_usage()` | Workspace usage counters |

Every tool scopes to the workspace the API key is bound to.

## Wiring it into agents (HTTP — recommended)

### Claude Code

Project-scoped config at `.mcp.json`:

```json
{
  "mcpServers": {
    "smartnote-cloud": {
      "url": "http://localhost:58000/mcp/",
      "headers": {
        "Authorization": "Bearer sn_live_..."
      }
    }
  }
}
```

When you deploy the cloud stack to a real host, change the URL; the
shape is identical. For remote mounts over the CLI:

```bash
claude mcp add --transport http --scope user smartnote-cloud \
  --header "Authorization: Bearer sn_live_..." \
  http://your-host/mcp/
```

### Cursor

Add to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "smartnote-cloud": {
      "url": "http://localhost:58000/mcp/",
      "headers": {
        "Authorization": "Bearer sn_live_..."
      }
    }
  }
}
```

Restart Cursor; verify in the MCP tools panel.

### OpenCode

In `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "smartnote-cloud": {
      "type": "remote",
      "url": "http://localhost:58000/mcp/",
      "headers": {
        "Authorization": "Bearer sn_live_..."
      },
      "enabled": true
    }
  }
}
```

## Trailing slash matters

Mount path is `/mcp/` — include the trailing slash in your config URL.
Starlette redirects `/mcp` → `/mcp/` (307), which some MCP clients
don't follow cleanly.

## Stdio fallback (`server.py` in this folder)

If your client can't do remote MCP, the sibling `server.py` in this
folder is a stdio bridge that talks to the same cloud API. Install:

```bash
cd cloud/mcp
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

Config example (Claude Code):

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

The HTTP path is preferred — same tools, zero install, works identically
once you deploy the cloud API to a real host.
