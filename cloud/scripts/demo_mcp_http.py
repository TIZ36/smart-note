"""End-to-end test of the HTTP MCP endpoint.

Uses the official MCP Python client with the streamable-HTTP transport
to connect to /mcp on the running cloud API. Mints a fresh API key via
/v1/dev/bootstrap, sends it as Authorization: Bearer, then exercises a
handful of tools to prove the bridge is wired up correctly.

This is the "is the cloud MCP actually usable?" smoke test.
"""

from __future__ import annotations

import asyncio
import os
import sys
import time
from pathlib import Path

import httpx

HERE = Path(__file__).resolve()
sys.path.insert(0, str(HERE.parents[1] / "sdk-py"))

from mcp.client.session import ClientSession  # noqa: E402
from mcp.client.streamable_http import streamablehttp_client  # noqa: E402


BASE = os.getenv("BASE", "http://localhost:58000")


def bootstrap_key() -> str:
    resp = httpx.post(
        f"{BASE}/v1/dev/bootstrap",
        json={
            "tenant_name": "mcp-http-demo",
            "workspace_name": "default",
            "workspace_slug": f"mcp-http-{int(time.time())}",
            "api_key_name": "mcp-http-demo",
        },
        timeout=10.0,
    )
    resp.raise_for_status()
    return resp.json()["api_key"]["secret"]


async def main() -> int:
    print(f"→ bootstrapping workspace via {BASE}")
    key = bootstrap_key()
    print(f"✓ key: {key[:30]}…")

    url = f"{BASE}/mcp/"
    headers = {"Authorization": f"Bearer {key}"}

    print(f"→ opening MCP streamable-http session at {url}")
    async with streamablehttp_client(url, headers=headers) as (read, write, _meta):
        async with ClientSession(read, write) as session:
            init = await session.initialize()
            print(f"✓ server: {init.serverInfo.name} v{init.serverInfo.version}")

            tools = await session.list_tools()
            names = [t.name for t in tools.tools]
            print(f"✓ {len(names)} tools exposed: {', '.join(names[:6])}…")

            # Call set_preference
            r = await session.call_tool("set_preference", {
                "key": "channel", "value": "cursor",
                "description": "tested via remote MCP",
            })
            print(f"  set_preference → {r.content[0].text}")

            # Call add_memory
            r = await session.call_tool("add_memory", {
                "content": "Verified the HTTP MCP transport end-to-end.",
                "kind": "episode",
                "tags": ["milestone"],
            })
            print(f"  add_memory    → {r.content[0].text}")

            # Call search_memory
            r = await session.call_tool("search_memory", {
                "query": "http mcp transport", "topk": 3,
            })
            text = r.content[0].text
            print("  search_memory →")
            for line in text.splitlines()[:4]:
                print(f"    {line}")

            r = await session.call_tool("get_usage", {})
            usage_text = r.content[0].text
            print("  get_usage     →")
            for line in usage_text.splitlines():
                print(f"    {line}")

    print("\n🎉 HTTP MCP bridge works end-to-end — no local install required")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
