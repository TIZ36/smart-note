"""MCP bridge smoke test.

Imports the MCP server module and invokes its tool functions directly
(unwrapping the FastMCP decorator). This doesn't spawn a stdio MCP
session — it proves the tool implementations talk to the cloud API
correctly end-to-end, which is what matters for the agent-facing shape.

A full stdio handshake test would need spinning up the MCP SDK's stdio
client harness; not worth the complexity when we can invoke the tools
directly for the same coverage.
"""

from __future__ import annotations

import os
import sys
import time
from pathlib import Path

import httpx

HERE = Path(__file__).resolve()
sys.path.insert(0, str(HERE.parents[1] / "sdk-py"))
sys.path.insert(0, str(HERE.parents[1] / "mcp"))


BASE = os.getenv("BASE", "http://localhost:58000")


def bootstrap_key() -> str:
    resp = httpx.post(
        f"{BASE}/v1/dev/bootstrap",
        json={
            "tenant_name": "mcp-demo",
            "workspace_name": "default",
            "workspace_slug": f"mcp-demo-{int(time.time())}",
            "api_key_name": "mcp-demo-key",
        },
        timeout=10.0,
    )
    resp.raise_for_status()
    return resp.json()["api_key"]["secret"]


def main() -> int:
    print(f"→ bootstrapping cloud workspace via {BASE}")
    key = bootstrap_key()
    os.environ["SMARTNOTE_API_KEY"] = key
    os.environ["SMARTNOTE_BASE_URL"] = BASE
    print(f"✓ api key minted: {key[:18]}…")

    # Import AFTER env is set so the module reads the right values.
    import server as mcp_server  # type: ignore

    # FastMCP.tool() returns the wrapped callable; the underlying
    # function is still callable directly. For the @mcp.tool() decorator
    # the returned object is the original function, so we can invoke it
    # as-is.
    tools = {
        name: getattr(mcp_server, name)
        for name in (
            "search_memory", "add_memory", "list_memories", "get_memory",
            "update_memory", "delete_memory",
            "set_preference", "get_preference", "list_preferences",
            "delete_preference",
            "add_document", "list_documents", "get_usage",
        )
    }
    print(f"✓ imported {len(tools)} tools from the MCP module")

    def run(name: str, *args, **kwargs):
        print(f"\n→ {name}({', '.join(repr(a) for a in args) + ('  ' + str(kwargs) if kwargs else '')})")
        result = tools[name](*args, **kwargs)
        for line in result.splitlines()[:8]:
            print(f"  │ {line}")
        return result

    r = run("set_preference", "reply_lang", "zh",
            description="default response language")
    assert "Set preference" in r

    r = run("add_memory",
            "User is dogfooding SmartNote Cloud through the MCP bridge.",
            "fact", "global", ["milestone"])
    mem_id = r.split("id=")[-1].strip()
    assert len(mem_id) > 10

    run("add_document", "mcp-test.md",
        "# Why MCP matters\n\nBridging a REST memory API through MCP "
        "means Claude Code and Cursor can share context with zero "
        "custom integration. That's the whole point.",
        True)

    r = run("search_memory", "why does mcp matter for agents", None, 5)
    assert "Matches for" in r or "No matches" in r

    run("list_memories", None, None, 5)
    run("list_preferences")
    run("get_preference", "reply_lang")
    run("get_usage")

    # Update + delete round-trip
    run("update_memory", mem_id, None, ["milestone", "w1"])
    run("delete_memory", mem_id)
    run("delete_preference", "reply_lang")

    print("\n🎉 MCP bridge smoke test passed — tools wired end-to-end to the cloud API")
    return 0


if __name__ == "__main__":
    sys.exit(main())
