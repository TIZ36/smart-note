"""MCP Client — connect to any MCP server, list tools, call tools.

Supports:
- Streamable HTTP (with or without token in URL)
- SSE transport
- OAuth (future)

Used by wiki import to fetch documents from external sources (Feishu, Notion, etc.)
"""

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
from typing import Any

from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client


# ── MCP Server Config ──

CONFIG_PATH = Path(os.getenv("MCP_CONFIG_PATH", "./data/mcp_servers.json"))


def _load_servers() -> list[dict]:
    if CONFIG_PATH.exists():
        try:
            return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, TypeError):
            pass
    return []


def _save_servers(servers: list[dict]):
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    CONFIG_PATH.write_text(json.dumps(servers, indent=2, ensure_ascii=False), encoding="utf-8")


def list_servers() -> list[dict]:
    return _load_servers()


def add_server(name: str, url: str, transport: str = "streamable_http", auth: dict | None = None) -> list[dict]:
    servers = _load_servers()
    # Upsert by name
    servers = [s for s in servers if s["name"] != name]
    servers.append({
        "name": name,
        "url": url,
        "transport": transport,
        "auth": auth or {},
    })
    _save_servers(servers)
    return servers


def remove_server(name: str) -> list[dict]:
    servers = _load_servers()
    servers = [s for s in servers if s["name"] != name]
    _save_servers(servers)
    return servers


def get_server(name: str) -> dict | None:
    for s in _load_servers():
        if s["name"] == name:
            return s
    return None


# ── MCP Client Operations ──

async def _connect_and_run(server: dict, fn):
    """Connect to an MCP server and run an async function with the session."""
    url = server["url"]
    transport = server.get("transport", "streamable_http")

    if transport == "streamable_http":
        async with streamablehttp_client(url) as (read_stream, write_stream, _):
            async with ClientSession(read_stream, write_stream) as session:
                await session.initialize()
                return await fn(session)
    else:
        raise ValueError(f"Unsupported transport: {transport}")


async def _list_tools(server: dict) -> list[dict]:
    async def fn(session: ClientSession):
        result = await session.list_tools()
        return [
            {
                "name": t.name,
                "description": t.description or "",
                "input_schema": t.inputSchema if hasattr(t, "inputSchema") else {},
            }
            for t in result.tools
        ]
    return await _connect_and_run(server, fn)


def _unwrap_json_content(raw: str) -> str:
    """Unwrap API JSON wrappers — e.g. Feishu returns {"code":0,"data":{"content":"..."}}."""
    stripped = raw.strip()
    if not stripped.startswith("{"):
        return raw
    try:
        parsed = json.loads(stripped, strict=False)
        if isinstance(parsed, dict):
            data = parsed.get("data", parsed)
            if isinstance(data, dict) and "content" in data:
                return data["content"]
            for v in (data.values() if isinstance(data, dict) else []):
                if isinstance(v, str) and len(v) > 50:
                    return v
        return raw
    except (json.JSONDecodeError, TypeError):
        return raw


async def _call_tool(server: dict, tool_name: str, arguments: dict) -> Any:
    async def fn(session: ClientSession):
        result = await session.call_tool(tool_name, arguments)
        # Extract and unwrap text content from each result block
        texts = []
        for content in result.content:
            if hasattr(content, "text"):
                unwrapped = _unwrap_json_content(content.text)
                if unwrapped.strip():
                    texts.append(unwrapped)
        # Deduplicate — Feishu sometimes returns same content in multiple blocks
        seen = set()
        unique = []
        for t in texts:
            key = t.strip()[:200]
            if key not in seen:
                seen.add(key)
                unique.append(t)
        return "\n\n".join(unique) if unique else ""
    return await _connect_and_run(server, fn)


async def _list_resources(server: dict) -> list[dict]:
    async def fn(session: ClientSession):
        result = await session.list_resources()
        return [
            {
                "uri": r.uri,
                "name": r.name or "",
                "description": r.description or "",
                "mimeType": r.mimeType or "",
            }
            for r in result.resources
        ]
    return await _connect_and_run(server, fn)


async def _read_resource(server: dict, uri: str) -> str:
    async def fn(session: ClientSession):
        result = await session.read_resource(uri)
        texts = []
        for content in result.contents:
            if hasattr(content, "text"):
                texts.append(content.text)
        return "\n\n".join(texts) if texts else ""
    return await _connect_and_run(server, fn)


# ── Sync wrappers (for use from FastAPI sync endpoints) ──

def _run_async(coro):
    """Run async function from sync context."""
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None

    if loop and loop.is_running():
        # Already in an async context (e.g., FastAPI with uvicorn)
        import concurrent.futures
        with concurrent.futures.ThreadPoolExecutor() as pool:
            return pool.submit(asyncio.run, coro).result(timeout=60)
    else:
        return asyncio.run(coro)


def mcp_list_tools(server_name: str) -> list[dict]:
    server = get_server(server_name)
    if not server:
        raise ValueError(f"MCP server not found: {server_name}")
    return _run_async(_list_tools(server))


def mcp_call_tool(server_name: str, tool_name: str, arguments: dict | None = None) -> str:
    server = get_server(server_name)
    if not server:
        raise ValueError(f"MCP server not found: {server_name}")
    return _run_async(_call_tool(server, tool_name, arguments or {}))


def mcp_list_resources(server_name: str) -> list[dict]:
    server = get_server(server_name)
    if not server:
        raise ValueError(f"MCP server not found: {server_name}")
    return _run_async(_list_resources(server))


def mcp_read_resource(server_name: str, uri: str) -> str:
    server = get_server(server_name)
    if not server:
        raise ValueError(f"MCP server not found: {server_name}")
    return _run_async(_read_resource(server, uri))
