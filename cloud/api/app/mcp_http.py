"""HTTP-hosted MCP endpoint — mounted at /mcp on the cloud API.

Lets any MCP client (Claude Code / Cursor / OpenCode with remote MCP
support) connect to the cloud service by URL + Authorization bearer,
with zero local install.

Design notes:

  * All tools are **async** — they use httpx.AsyncClient directly rather
    than the sync Python SDK. Sync HTTP inside FastMCP's sync-tool
    threadpool worked in isolation but deadlocks intermittently against
    the MCP session manager on the same event loop.

  * We still loop back through the REST layer (rather than calling DB
    handlers directly) so every MCP request goes through the same
    auth/scope checks as an external REST call — no duplicated
    enforcement path.

  * The Authorization header is captured per-request via a ContextVar
    set by a small ASGI middleware; tools read it on invocation. We
    cache the exchanged JWT per API-key inside the process so we don't
    re-exchange on every tool call.
"""

from __future__ import annotations

import os
import time
from contextvars import ContextVar
from typing import Any, Optional

import httpx
from mcp.server.fastmcp import FastMCP
from starlette.types import ASGIApp, Receive, Scope, Send


_api_key_ctx: ContextVar[str] = ContextVar("smartnote_api_key", default="")

# In-process host to call ourselves on. In Docker the api listens on 8000
# inside the container; the host port (58000) is irrelevant here. Override
# via MCP_SELF_BASE_URL if the api is somewhere else.
_SELF_BASE = os.getenv("MCP_SELF_BASE_URL", "http://127.0.0.1:8000")

# Cache: api_key → (jwt, exp_epoch). Re-use JWTs across tool invocations
# so we skip the /v1/auth/token round-trip after the first call.
_jwt_cache: dict[str, tuple[str, int]] = {}
_JWT_REFRESH_MARGIN = 30


mcp = FastMCP(
    "SmartNote Cloud",
    instructions=(
        "SmartNote Cloud is a cross-agent memory service. Tools scope to the "
        "workspace the Authorization-header API key is bound to. Use "
        "search_memory for recall, add_memory / set_preference for writes, "
        "add_document to ingest longer text."
    ),
    stateless_http=True,
    streamable_http_path="/",
)


# ── auth + HTTP proxy helpers ────────────────────────────────────

async def _jwt_for(key: str) -> str:
    now = int(time.time())
    cached = _jwt_cache.get(key)
    if cached and cached[1] > now + _JWT_REFRESH_MARGIN:
        return cached[0]
    async with httpx.AsyncClient(timeout=10.0) as c:
        resp = await c.post(f"{_SELF_BASE}/v1/auth/token", json={"api_key": key})
    if resp.status_code != 200:
        raise PermissionError(
            f"api key rejected ({resp.status_code}): {resp.text[:200]}"
        )
    data = resp.json()
    _jwt_cache[key] = (data["jwt"], int(data["expires_at"]))
    return data["jwt"]


async def _call(
    method: str, path: str,
    *, json: Any | None = None, params: dict | None = None,
) -> httpx.Response:
    key = _api_key_ctx.get()
    if not key:
        raise PermissionError(
            "Missing Authorization header. MCP clients must send "
            "'Authorization: Bearer sn_live_...' on every request."
        )
    jwt = await _jwt_for(key)
    async with httpx.AsyncClient(timeout=30.0) as c:
        r = await c.request(
            method, f"{_SELF_BASE}{path}",
            json=json, params=params,
            headers={"Authorization": f"Bearer {jwt}"},
        )
        if r.status_code == 401:
            # JWT might have expired mid-call; drop the cache + retry once.
            _jwt_cache.pop(key, None)
            jwt = await _jwt_for(key)
            r = await c.request(
                method, f"{_SELF_BASE}{path}",
                json=json, params=params,
                headers={"Authorization": f"Bearer {jwt}"},
            )
    return r


def _fail(r: httpx.Response, action: str) -> str:
    try:
        detail = r.json().get("detail") or r.text[:200]
    except Exception:
        detail = r.text[:200]
    return f"{action} failed ({r.status_code}): {detail}"


# ── Tools ──────────────────────────────────────────────────────

@mcp.tool()
async def search_memory(
    query: str,
    kinds: Optional[list[str]] = None,
    topk: int = 8,
) -> str:
    """Search memories by meaning + keyword. Ranks by vector similarity
    blended with substring match; pinned items always rank first.

    Args:
        query: Natural-language description of what you're looking for.
        kinds: Optional filter (e.g. ["preference"], ["fact","episode"]).
        topk: Max results (default 8).
    """
    body: dict[str, Any] = {"query": query, "topk": topk}
    if kinds:
        body["kinds"] = kinds
    r = await _call("POST", "/v1/retrieve", json=body)
    if r.status_code != 200:
        return _fail(r, "search_memory")
    data = r.json()
    results = data.get("results") or []
    if not results:
        return f"No matches for: {query}"
    lines = [f"Matches for: {query}"]
    for hit in results:
        lines.append(
            f"- [{hit['kind']}, score={hit.get('score', 0):.2f}] "
            f"{hit['content']}  (id={hit['id']})"
        )
    return "\n".join(lines)


@mcp.tool()
async def add_memory(
    content: str,
    kind: str = "fact",
    scope: str = "global",
    tags: Optional[list[str]] = None,
    structured: Optional[dict[str, Any]] = None,
    pinned: bool = False,
) -> str:
    """Record a new memory. kind ∈ fact | preference | procedure | episode
    | document_ref. For durable user preferences, prefer `set_preference`
    (cleaner supersede history)."""
    body: dict[str, Any] = {
        "kind": kind, "content": content, "scope": scope,
        "tags": tags or [], "pinned": pinned,
    }
    if structured is not None:
        body["structured"] = structured
    r = await _call("POST", "/v1/memories", json=body)
    if r.status_code != 200:
        return _fail(r, "add_memory")
    return f"Saved {kind} memory id={r.json()['id']}"


@mcp.tool()
async def list_memories(
    kind: Optional[str] = None,
    scope: Optional[str] = None,
    limit: int = 20,
) -> str:
    """List memories newest-first. Prefer `search_memory` for hunting
    specific content."""
    params: dict[str, Any] = {"limit": limit}
    if kind: params["kind"] = kind
    if scope: params["scope"] = scope
    r = await _call("GET", "/v1/memories", params=params)
    if r.status_code != 200:
        return _fail(r, "list_memories")
    rows = r.json().get("memories") or []
    if not rows:
        return "No memories."
    out = [f"Memories ({len(rows)}):"]
    for row in rows:
        pin = "📌 " if row.get("pinned") else ""
        out.append(f"- {pin}[{row['kind']}] {row['content'][:120]}  (id={row['id']})")
    return "\n".join(out)


@mcp.tool()
async def get_memory(memory_id: str) -> str:
    """Fetch a memory by id — use after search_memory to inspect the
    structured payload."""
    r = await _call("GET", f"/v1/memories/{memory_id}")
    if r.status_code != 200:
        return _fail(r, "get_memory")
    data = r.json()
    lines = [
        f"id: {data['id']}",
        f"kind: {data['kind']}",
        f"scope: {data['scope']}",
        f"pinned: {data['pinned']}",
        f"tags: {data.get('tags') or []}",
        f"content:\n  {data['content']}",
    ]
    if data.get("structured"):
        lines.append(f"structured: {data['structured']}")
    return "\n".join(lines)


@mcp.tool()
async def update_memory(
    memory_id: str,
    content: Optional[str] = None,
    tags: Optional[list[str]] = None,
    pinned: Optional[bool] = None,
    structured: Optional[dict[str, Any]] = None,
) -> str:
    """Partial update. Updating `content` re-embeds so future searches
    reflect the revised meaning."""
    body: dict[str, Any] = {}
    if content is not None: body["content"] = content
    if tags is not None: body["tags"] = tags
    if pinned is not None: body["pinned"] = pinned
    if structured is not None: body["structured"] = structured
    if not body:
        return "Nothing to update."
    r = await _call("PATCH", f"/v1/memories/{memory_id}", json=body)
    if r.status_code != 200:
        return _fail(r, "update_memory")
    return f"Updated memory id={memory_id}: {sorted(body.keys())}"


@mcp.tool()
async def delete_memory(memory_id: str) -> str:
    """Delete a memory permanently."""
    r = await _call("DELETE", f"/v1/memories/{memory_id}")
    if r.status_code != 200:
        return _fail(r, "delete_memory")
    return f"Deleted memory id={memory_id}"


@mcp.tool()
async def set_preference(
    key: str,
    value: Any,
    description: Optional[str] = None,
) -> str:
    """Set a durable user preference. Old value is superseded (history
    kept for audit)."""
    r = await _call("PUT", f"/v1/preferences/{key}",
                    json={"value": value, "description": description})
    if r.status_code != 200:
        return _fail(r, "set_preference")
    note = f" ({description})" if description else ""
    return f"Set preference {key} = {value}{note} (memory_id={r.json()['memory_id']})"


@mcp.tool()
async def get_preference(key: str) -> str:
    """Read a preference's current value."""
    r = await _call("GET", f"/v1/preferences/{key}")
    if r.status_code == 404:
        return f"preference not set: {key}"
    if r.status_code != 200:
        return _fail(r, "get_preference")
    data = r.json()
    desc = f" — {data['description']}" if data.get("description") else ""
    return f"{key} = {data['value']}{desc}"


@mcp.tool()
async def list_preferences() -> str:
    """List every preference currently set (current values, not audit history)."""
    r = await _call("GET", "/v1/preferences")
    if r.status_code != 200:
        return _fail(r, "list_preferences")
    flat = r.json().get("preferences") or {}
    if not flat:
        return "No preferences set."
    out = ["Preferences:"]
    for k in sorted(flat):
        p = flat[k]
        desc = f" — {p['description']}" if p.get("description") else ""
        out.append(f"- {k} = {p['value']}{desc}")
    return "\n".join(out)


@mcp.tool()
async def delete_preference(key: str) -> str:
    """Delete a preference (history rows stay for audit)."""
    r = await _call("DELETE", f"/v1/preferences/{key}")
    if r.status_code == 404:
        return f"preference not set: {key}"
    if r.status_code != 200:
        return _fail(r, "delete_preference")
    return f"Deleted preference: {key}"


@mcp.tool()
async def add_document(
    name: str,
    content: str,
    ingest: bool = True,
) -> str:
    """Upload a document and chunk + embed it so its content becomes
    retrievable via search_memory."""
    r = await _call("POST", "/v1/documents",
                    json={"name": name, "content": content, "kind": "text"})
    if r.status_code != 200:
        return _fail(r, "add_document")
    doc = r.json()
    chunks = 0
    if ingest:
        ri = await _call("POST", f"/v1/documents/{doc['id']}/ingest")
        if ri.status_code == 200:
            chunks = ri.json().get("chunks", 0)
    tail = f" — ingested {chunks} chunk(s)" if ingest else " — not ingested"
    return f"Added document id={doc['id']} ({doc['byte_size']} bytes){tail}"


@mcp.tool()
async def list_documents() -> str:
    """List every document in the workspace, newest first."""
    r = await _call("GET", "/v1/documents")
    if r.status_code != 200:
        return _fail(r, "list_documents")
    docs = r.json().get("documents") or []
    if not docs:
        return "No documents."
    out = [f"Documents ({len(docs)}):"]
    for d in docs:
        ingested = "ingested" if d.get("ingested_at") else "not ingested"
        out.append(f"- {d['name']}  ({d['byte_size']}B, {ingested}, id={d['id']})")
    return "\n".join(out)


@mcp.tool()
async def get_usage() -> str:
    """Show the workspace's current usage counters."""
    r = await _call("GET", "/v1/usage")
    if r.status_code != 200:
        return _fail(r, "get_usage")
    u = r.json()
    return (
        f"Workspace usage:\n"
        f"  memories:        {u['memory_count']}\n"
        f"  documents:       {u['document_count']}\n"
        f"  embed tokens:    {u['embed_tokens']}\n"
        f"  retrieve calls:  {u['retrieve_calls']}"
    )


# ── ASGI middleware: extract Authorization → contextvar ──────────

class ApiKeyMiddleware:
    """Pulls `Authorization: Bearer …` off every incoming request and
    stashes the token in `_api_key_ctx` so tools can read it without
    threading the header through MCP protocol plumbing."""

    def __init__(self, app: ASGIApp):
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http":
            for key, value in scope.get("headers") or []:
                if key == b"authorization":
                    raw = value.decode("latin-1").strip()
                    if raw.lower().startswith("bearer "):
                        _api_key_ctx.set(raw.split(" ", 1)[1].strip())
                    break
        await self.app(scope, receive, send)


def build_mcp_asgi() -> ASGIApp:
    return ApiKeyMiddleware(mcp.streamable_http_app())
