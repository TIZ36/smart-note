"""SmartNote Cloud — MCP bridge.

An MCP server that lets any MCP-compatible agent (Claude Code, Cursor,
OpenCode, …) read/write the user's cloud memory, preferences, and
documents. It's a thin wrapper on top of the Python SDK — the SDK owns
the token lifecycle (api_key → JWT with auto-renew), this module just
presents those primitives as MCP tools.

Config:
  SMARTNOTE_API_KEY   — required; the `sn_live_…` key from the console
  SMARTNOTE_BASE_URL  — optional; defaults to http://localhost:58000
  SMARTNOTE_AGENT     — optional label surfaced to the server as agent_id
                        (most agents don't need to set this; leave blank)

Run (from a venv with `smartnote_cloud` + `mcp[cli]` installed):
  python -m smartnote_cloud_mcp
  # or:
  python server.py
"""

from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Any, Optional

# Allow running straight from the repo without installing: put the sibling
# sdk-py on sys.path first. Harmless in installed mode since the installed
# package wins on import precedence via the site-packages layout.
_HERE = Path(__file__).resolve()
sys.path.insert(0, str(_HERE.parents[1] / "sdk-py"))

from mcp.server.fastmcp import FastMCP                              # noqa: E402

from smartnote_cloud import Client, SmartNoteAuthError, SmartNoteError  # noqa: E402


API_KEY = os.getenv("SMARTNOTE_API_KEY", "").strip()
BASE_URL = os.getenv("SMARTNOTE_BASE_URL", "http://localhost:58000").strip()

mcp = FastMCP(
    "SmartNote Cloud",
    instructions=(
        "SmartNote Cloud is a cross-agent memory service. Use these tools to "
        "remember facts/preferences/procedures for the user, retrieve them "
        "later via `search_memory`, and ingest documents so their content "
        "becomes retrievable. Every tool runs against the user's single "
        "workspace (scoped by the API key in env)."
    ),
)


_client: Client | None = None


def _sn() -> Client:
    """Lazy SDK client — instantiated on first tool call so a missing
    API key fails a specific request rather than the whole server boot."""
    global _client
    if _client is None:
        if not API_KEY:
            raise RuntimeError(
                "SMARTNOTE_API_KEY is not set. Get one from the console "
                "(or run POST /v1/dev/bootstrap in local dev)."
            )
        _client = Client(api_key=API_KEY, base_url=BASE_URL)
    return _client


def _err(e: Exception) -> str:
    """Render SDK errors as human-readable strings for the MCP response.
    We never raise into the MCP transport — tool errors become text so
    the calling agent can recover / explain rather than crash."""
    if isinstance(e, SmartNoteAuthError):
        return f"auth error ({e.status}): {e} — check SMARTNOTE_API_KEY / scopes"
    if isinstance(e, SmartNoteError):
        return f"api error ({e.status}): {e}"
    return f"error: {e}"


# ── Tools: memories ────────────────────────────────────────────

@mcp.tool()
def search_memory(
    query: str,
    kinds: Optional[list[str]] = None,
    topk: int = 8,
) -> str:
    """Search the user's memories by meaning + keyword.

    Prefer this over listing memories when you're trying to answer a
    question — it ranks by vector similarity + substring match, with
    pinned memories always first.

    Args:
        query: Natural-language description of what you're looking for.
        kinds: Optional filter (e.g. ["preference"], ["fact","episode"]).
        topk: Max results to return (default 8).
    """
    try:
        data = _sn().retrieve(query, kinds=kinds, topk=topk)
    except Exception as e:
        return _err(e)
    results = data.get("results", [])
    if not results:
        return f"No matches for: {query}"
    lines = [f"Matches for: {query}"]
    for r in results:
        score = r.get("score", 0)
        lines.append(
            f"- [{r['kind']}, score={score:.2f}] {r['content']}"
            + (f"  (id={r['id']})")
        )
    return "\n".join(lines)


@mcp.tool()
def add_memory(
    content: str,
    kind: str = "fact",
    scope: str = "global",
    tags: Optional[list[str]] = None,
    structured: Optional[dict[str, Any]] = None,
    pinned: bool = False,
) -> str:
    """Record a new memory for the user.

    Use `kind="preference"` for durable user preferences (or prefer the
    dedicated `set_preference` tool for those), `kind="fact"` for
    user-specific truths, `kind="episode"` for "this happened" notes,
    `kind="procedure"` for multi-step workflows the user wants
    remembered.

    Args:
        content: The natural-language text of the memory.
        kind: one of fact | preference | procedure | episode | document_ref.
        scope: "global" (default) or e.g. "project:<slug>" to scope the
            memory to a subset of contexts.
        tags: Optional string tags for filtering later.
        structured: Optional structured payload — useful for preferences
            (e.g. `{"key": "lang", "value": "zh"}`).
        pinned: Pinned memories always rank first in `search_memory`.
            Use sparingly — only for things that should outweigh every
            other signal.
    """
    try:
        mem = _sn().memories.add(
            kind=kind, content=content, scope=scope,
            tags=tags or [], structured=structured, pinned=pinned,
        )
    except Exception as e:
        return _err(e)
    return f"Saved {kind} memory id={mem['id']}"


@mcp.tool()
def list_memories(
    kind: Optional[str] = None,
    scope: Optional[str] = None,
    limit: int = 20,
) -> str:
    """List memories in the workspace, newest first.

    For finding specific content prefer `search_memory` — this is for
    browsing / inventory only.
    """
    try:
        rows = _sn().memories.list(kind=kind, scope=scope, limit=limit)
    except Exception as e:
        return _err(e)
    if not rows:
        return "No memories."
    out = [f"Memories ({len(rows)}):"]
    for r in rows:
        pin = "📌 " if r.get("pinned") else ""
        out.append(f"- {pin}[{r['kind']}] {r['content'][:120]}  (id={r['id']})")
    return "\n".join(out)


@mcp.tool()
def get_memory(memory_id: str) -> str:
    """Fetch a memory by id. Use this after `search_memory` when you need
    the full structured payload (e.g. to decide what to update)."""
    try:
        r = _sn().memories.get(memory_id)
    except Exception as e:
        return _err(e)
    parts = [
        f"id: {r['id']}",
        f"kind: {r['kind']}",
        f"scope: {r['scope']}",
        f"pinned: {r['pinned']}",
        f"tags: {r.get('tags') or []}",
        f"content:\n  {r['content']}",
    ]
    if r.get("structured"):
        parts.append(f"structured: {r['structured']}")
    if r.get("supersedes"):
        parts.append(f"supersedes: {r['supersedes']}")
    return "\n".join(parts)


@mcp.tool()
def update_memory(
    memory_id: str,
    content: Optional[str] = None,
    tags: Optional[list[str]] = None,
    pinned: Optional[bool] = None,
    structured: Optional[dict[str, Any]] = None,
) -> str:
    """Partially update a memory. Pass only what you want to change —
    omitted fields stay untouched. Updating `content` re-embeds it, so
    new searches reflect the revised meaning."""
    updates: dict[str, Any] = {}
    if content is not None: updates["content"] = content
    if tags is not None: updates["tags"] = tags
    if pinned is not None: updates["pinned"] = pinned
    if structured is not None: updates["structured"] = structured
    if not updates:
        return "Nothing to update — pass at least one of content/tags/pinned/structured."
    try:
        _sn().memories.patch(memory_id, **updates)
    except Exception as e:
        return _err(e)
    return f"Updated memory id={memory_id}: {sorted(updates.keys())}"


@mcp.tool()
def delete_memory(memory_id: str) -> str:
    """Delete a memory permanently. For preferences, prefer
    `delete_preference` which handles supersede chains."""
    try:
        _sn().memories.delete(memory_id)
    except Exception as e:
        return _err(e)
    return f"Deleted memory id={memory_id}"


# ── Tools: preferences ──────────────────────────────────────────

@mcp.tool()
def set_preference(
    key: str,
    value: Any,
    description: Optional[str] = None,
) -> str:
    """Set a user preference (key → value).

    If the key already exists, the old row is superseded (history is kept
    for audit but `get_preference` only returns the current value).

    Args:
        key: Preference key (e.g. "code_style", "reply_lang", "timezone").
        value: Any JSON-serializable value.
        description: Optional human-readable note on why/when this was set.
    """
    try:
        pref = _sn().preferences.set(key, value, description=description)
    except Exception as e:
        return _err(e)
    note = f" ({description})" if description else ""
    return f"Set preference {key} = {value}{note} (memory_id={pref['memory_id']})"


@mcp.tool()
def get_preference(key: str) -> str:
    """Read a single preference value. Returns an error if unset."""
    try:
        p = _sn().preferences.get(key)
    except SmartNoteError as e:
        if e.status == 404:
            return f"preference not set: {key}"
        return _err(e)
    except Exception as e:
        return _err(e)
    desc = f" — {p['description']}" if p.get("description") else ""
    return f"{key} = {p['value']}{desc}"


@mcp.tool()
def list_preferences() -> str:
    """List every preference currently set (not the audit history)."""
    try:
        flat = _sn().preferences.all()
    except Exception as e:
        return _err(e)
    if not flat:
        return "No preferences set."
    out = ["Preferences:"]
    for k, p in sorted(flat.items()):
        desc = f" — {p['description']}" if p.get("description") else ""
        out.append(f"- {k} = {p['value']}{desc}")
    return "\n".join(out)


@mcp.tool()
def delete_preference(key: str) -> str:
    """Remove a preference. History rows (older supersedes) are kept for
    audit; only the current row is removed."""
    try:
        _sn().preferences.delete(key)
    except SmartNoteError as e:
        if e.status == 404:
            return f"preference not set: {key}"
        return _err(e)
    except Exception as e:
        return _err(e)
    return f"Deleted preference: {key}"


# ── Tools: documents ────────────────────────────────────────────

@mcp.tool()
def add_document(
    name: str,
    content: str,
    ingest: bool = True,
) -> str:
    """Upload a document into the workspace and (by default) chunk +
    embed it immediately so its content is retrievable.

    Args:
        name: Human label for the document.
        content: Raw text. Markdown and plain text both fine.
        ingest: If True (default), chunk + embed right after upload.
    """
    try:
        doc = _sn().documents.add(name=name, content=content)
        chunks = 0
        if ingest:
            result = _sn().documents.ingest(doc["id"])
            chunks = result.get("chunks", 0)
    except Exception as e:
        return _err(e)
    tail = f" — ingested {chunks} chunk(s)" if ingest else " — not ingested"
    return f"Added document id={doc['id']} ({doc['byte_size']} bytes){tail}"


@mcp.tool()
def list_documents() -> str:
    """List every document in the workspace, newest first."""
    try:
        docs = _sn().documents.list()
    except Exception as e:
        return _err(e)
    if not docs:
        return "No documents."
    out = [f"Documents ({len(docs)}):"]
    for d in docs:
        ingested = "ingested" if d.get("ingested_at") else "not ingested"
        out.append(
            f"- {d['name']}  ({d['byte_size']}B, {ingested}, id={d['id']})"
        )
    return "\n".join(out)


# ── Tools: usage ────────────────────────────────────────────────

@mcp.tool()
def get_usage() -> str:
    """Show the workspace's current usage counters (memory count,
    document count, embed tokens spent, retrieve calls this month)."""
    try:
        u = _sn().usage.current()
    except Exception as e:
        return _err(e)
    return (
        f"Workspace usage:\n"
        f"  memories:        {u['memory_count']}\n"
        f"  documents:       {u['document_count']}\n"
        f"  embed tokens:    {u['embed_tokens']}\n"
        f"  retrieve calls:  {u['retrieve_calls']}"
    )


if __name__ == "__main__":
    mcp.run()
