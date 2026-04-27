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
    # Mark this workspace as having a live MCP session — feeds the
    # mcp_pull executor's availability check.
    try:
        from app.security import verify_jwt as _vj
        from app.services.enrich.executors import mcp_pull as _mp
        claims = _vj(jwt)
        if claims:
            _mp.mark_active(claims.workspace_id)
    except Exception:
        pass
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


# ── Output formatting helpers ──────────────────────────────────
#
# Design: tool results are rendered inside the agent's conversation
# UI (Cursor / Claude Code / etc.) directly below the user's message
# bubble. Verbose text explodes that space. Default behavior across
# list/search tools is compact — content truncated to ~60 chars, full
# UUID at the end (copyable for get_memory). Agents that really need
# full content inline pass verbose=True.

def _truncate(text: str, limit: int = 60) -> str:
    t = " ".join((text or "").split())
    return t if len(t) <= limit else t[: limit - 1] + "…"


# ── Tools ──────────────────────────────────────────────────────

@mcp.tool()
async def search_memory(
    query: str,
    kinds: Optional[list[str]] = None,
    topk: int = 8,
    verbose: bool = False,
) -> str:
    """Search memories by meaning + keyword.

    DEFAULT OUTPUT IS COMPACT: one chip per hit (short-id · kind · score
    · 60-char preview). Full content is NOT inlined because tool output
    is rendered under the user's message bubble in most agent UIs — long
    dumps clutter the conversation. For full content, call
    `get_memory(id)` with the short id shown here (8 hex chars prefix
    is enough to disambiguate).

    Args:
        query: Natural-language description of what you're looking for.
        kinds: Optional filter (e.g. ["preference"], ["fact","episode"]).
        topk: Max results (default 8).
        verbose: Set True to dump full content inline (legacy behavior).
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
    if verbose:
        lines = [f"Matches for: {query}"]
        for hit in results:
            lines.append(
                f"- [{hit['kind']}, score={hit.get('score', 0):.2f}] "
                f"{hit['content']}  (id={hit['id']})"
            )
        return "\n".join(lines)
    chips = []
    for hit in results:
        preview = _truncate(hit['content'], 60)
        chips.append(
            f"[{hit['kind']}·{hit.get('score', 0):.2f}] {preview} · id={hit['id']}"
        )
    return (
        f"{len(results)} match(es) for \"{query}\":\n"
        + "\n".join(chips)
        + "\n\n→ get_memory(id) for full content"
    )


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
    verbose: bool = False,
) -> str:
    """List memories newest-first. Compact by default. Prefer
    `search_memory` when hunting for specific content."""
    params: dict[str, Any] = {"limit": limit}
    if kind: params["kind"] = kind
    if scope: params["scope"] = scope
    r = await _call("GET", "/v1/memories", params=params)
    if r.status_code != 200:
        return _fail(r, "list_memories")
    rows = r.json().get("memories") or []
    if not rows:
        return "No memories."
    out = [f"{len(rows)} memor{'y' if len(rows) == 1 else 'ies'}:"]
    for row in rows:
        pin = "📌" if row.get("pinned") else " "
        body = row['content'] if verbose else _truncate(row['content'], 60)
        out.append(f"{pin} [{row['kind']}] {body} · id={row['id']}")
    if not verbose:
        out.append("\n→ get_memory(id) for full content")
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
async def full_ingest(
    smartnote_type: Optional[str] = None,
    topic_prefix: Optional[str] = None,
) -> str:
    """Re-ingest cloud documents into the chunks index in one shot.

    "Ingest" here means: parse each document → split into 200-1500-char
    paragraph chunks → embed via the workspace's embed pod → land in
    the `chunks` table (pgvector + FTS5). Idempotent — re-running
    deletes the prior chunks for each doc and rebuilds.

    Filters (combine as you like):
      smartnote_type — restrict to one source type:
                       'note', 'wiki_topic', 'smart_table', 'skill'.
                       Omit to process BOTH `note` AND `wiki_topic`
                       (smart_table / skill are JSON-shaped and skip
                       chunking).
      topic_prefix   — when smartnote_type='wiki_topic', only ingest
                       wikis whose metadata.relative_path starts with
                       this string (e.g. '回传/' or '技术阅读/').

    Cost: chunking + embed only. NO LLM tag classification — for that
    use enrich tools (list_pending_enrichments → submit_enrichments).

    Returns a one-line summary plus per-failure detail.
    """
    body: dict[str, Any] = {}
    if smartnote_type:
        body["smartnote_type"] = smartnote_type
    if topic_prefix:
        body["topic_prefix"] = topic_prefix
    r = await _call("POST", "/v1/ingest/bulk", json=body)
    if r.status_code != 200:
        return _fail(r, "full_ingest")
    d = r.json()
    out = [
        f"Bulk ingest done: {d['ingested']}/{d['total']} docs · "
        f"{d['chunks']} chunks"
    ]
    if d.get("failures"):
        out.append(f"{len(d['failures'])} failure(s):")
        for f in d["failures"][:5]:
            out.append(f"  - {f['document_id'][:8]}: {f['error'][:80]}")
        if len(d["failures"]) > 5:
            out.append(f"  + {len(d['failures']) - 5} more")
    return "\n".join(out)


@mcp.tool()
async def propose_memory(
    content: str,
    kind: str = "fact",
    reason: Optional[str] = None,
    scope: str = "global",
    tags: Optional[list[str]] = None,
    structured: Optional[dict[str, Any]] = None,
    confidence: float = 0.5,
) -> str:
    """Submit a **low-confidence candidate** memory for review.

    Use this instead of `add_memory` when you're NOT certain the user
    wants this remembered — e.g. inferred preferences, guesses based
    on one mention, things that could be noise. The proposal lands
    with status='draft' in a queue; a reviewer (user or policy agent)
    promotes the good ones via `accept_proposal` and archives the rest
    via `reject_proposal`.

    Args:
        content: The natural-language memory text.
        kind: one of fact | preference | procedure | episode | document_ref.
        reason: Short sentence explaining why you think this is
            worth remembering (shown to the reviewer — helps them
            decide quickly). Examples: "user said 'I prefer X'",
            "user repeated this decision in 3 sessions", "derived
            from document-ref 'foo.md' chunk 12".
        scope / tags / structured: same semantics as add_memory.
        confidence: proposer's self-rated confidence (0.0-1.0). Default
            0.5. On accept, confidence is bumped to 1.0 unless the
            reviewer overrides.
    """
    body: dict[str, Any] = {
        "content": content, "kind": kind, "scope": scope,
        "tags": tags or [], "confidence": confidence,
    }
    if reason: body["reason"] = reason
    if structured is not None: body["structured"] = structured
    r = await _call("POST", "/v1/memories/proposals", json=body)
    if r.status_code != 200:
        return _fail(r, "propose_memory")
    data = r.json()
    lines = [f"Proposed {kind} memory id={data['id']} (status=draft)"]
    similar = data.get("similar_existing") or []
    if similar:
        lines.append("")
        lines.append("⚠ similar memories already exist — consider merging by setting supersedes on accept:")
        for s in similar[:3]:
            lines.append(f"  - {s['id']} (similarity={s['similarity']:.2f}) {s['content'][:80]}")
    return "\n".join(lines)


@mcp.tool()
async def list_proposals(
    kind: Optional[str] = None,
    limit: int = 20,
    verbose: bool = False,
) -> str:
    """List pending draft-status proposals awaiting review."""
    params: dict[str, Any] = {"limit": limit}
    if kind:
        params["kind"] = kind
    r = await _call("GET", "/v1/memories/proposals", params=params)
    if r.status_code != 200:
        return _fail(r, "list_proposals")
    data = r.json()
    rows = data.get("proposals") or []
    total = data.get("total", len(rows))
    if not rows:
        return "Draft queue is empty."
    out = [f"{len(rows)} of {total} draft(s):"]
    for p in rows:
        body = p['content'] if verbose else _truncate(p['content'], 60)
        line = (
            f"[{p['kind']}·{p['confidence']:.2f}·{p['author_agent']}] "
            f"{body} · id={p['id']}"
        )
        if verbose and p.get("proposal_reason"):
            line += f"\n  reason: {p['proposal_reason']}"
        out.append(line)
    if not verbose:
        out.append("\n→ get_memory(id) for full content")
    return "\n".join(out)


@mcp.tool()
async def accept_proposal(
    proposal_id: str,
    content: Optional[str] = None,
    tags: Optional[list[str]] = None,
    pinned: Optional[bool] = None,
    supersedes: Optional[str] = None,
) -> str:
    """Promote a draft proposal to an active memory. Optionally edit
    content / tags / pinned before accepting. Use `supersedes` to
    chain onto an existing similar memory (the merge path) — the
    similar-memory id comes back from `propose_memory` as
    `similar_existing`.
    """
    body: dict[str, Any] = {}
    if content is not None: body["content"] = content
    if tags is not None: body["tags"] = tags
    if pinned is not None: body["pinned"] = pinned
    if supersedes: body["supersedes"] = supersedes
    r = await _call("POST", f"/v1/memories/proposals/{proposal_id}/accept", json=body)
    if r.status_code != 200:
        return _fail(r, "accept_proposal")
    data = r.json()
    note = f" (supersedes {data['supersedes']})" if data.get("supersedes") else ""
    return f"Accepted proposal id={data['id']} → status=active, confidence={data['confidence']}{note}"


@mcp.tool()
async def reject_proposal(
    proposal_id: str,
    reason: Optional[str] = None,
) -> str:
    """Archive a draft proposal — it won't appear in retrieval results.
    Reason (optional) is appended to the row for auditing.
    """
    r = await _call("POST", f"/v1/memories/proposals/{proposal_id}/reject",
                    json={"reason": reason} if reason else {})
    if r.status_code != 200:
        return _fail(r, "reject_proposal")
    return f"Rejected proposal id={proposal_id} (archived)"


@mcp.tool()
async def ingest_notes(
    name: str,
    content: str,
) -> str:
    """Upload a note to the cloud and queue it for AI tag classification.

    The job lands in the workspace's enrich queue. If a connected agent
    (CC / Cursor with `mcp-always-allow`) is around, it can pull the
    job via `list_pending_enrichments` and classify with its own LLM
    plan — at zero extra token cost to the user. Otherwise the job
    waits for the workspace's primary device or cloud pool to handle it.
    """
    r = await _call("POST", "/v1/documents",
                    json={"name": name, "content": content, "kind": "markdown"})
    if r.status_code != 200:
        return _fail(r, "ingest_notes")
    doc = r.json()
    rj = await _call("POST", "/v1/enrich/run", json={"document_id": doc["id"]})
    if rj.status_code != 200:
        return f"Document saved (id={doc['id']}) but enrich queue failed: {_fail(rj, 'enqueue')}"
    job = rj.json()
    return (
        f"Ingested {name} (doc id={doc['id']}, {doc['byte_size']}B).\n"
        f"Enrich job id={job['id']} status={job['status']} — "
        "an MCP-connected agent can pick it up via list_pending_enrichments."
    )


@mcp.tool()
async def list_pending_enrichments(limit: int = 5) -> str:
    """List enrich jobs the agent can pull and classify with its own LLM.

    For each job you'll get the document content + the workspace's
    allowed tag list. Run classification in your own context, then
    submit results via `submit_enrichments(job_id, segments)`.
    """
    r = await _call("GET", "/v1/enrich/pending", params={"limit": limit})
    if r.status_code != 200:
        return _fail(r, "list_pending_enrichments")
    jobs = r.json()
    if not jobs:
        return "No pending enrichments."
    out = [f"{len(jobs)} pending enrichment(s):"]
    for j in jobs:
        out.append(
            f"- job={j['id']}  doc={j['document_name']}  "
            f"({len((j.get('content') or '').splitlines())} lines)\n"
            f"  tags: {j['tags']}\n"
            f"  → call submit_enrichments(job_id='{j['id']}', segments=[...]) when done"
        )
    return "\n".join(out)


@mcp.tool()
async def submit_enrichments(
    job_id: str,
    segments: list[dict[str, Any]],
    prompt_tokens: int = 0,
    completion_tokens: int = 0,
) -> str:
    """Submit classified segments for a pending enrich job.

    Each segment must be a dict with: line_start, line_end, tag,
    confidence (0-1), summary, secondary_tags, topic_name, keywords,
    entities, is_credential. Matches the shape returned by the
    classifier prompt — see the system prompt fetched alongside the job.
    """
    body = {
        "segments": segments,
        "executor": "mcp_pull",
        "prompt_tokens": prompt_tokens,
        "completion_tokens": completion_tokens,
        "total_tokens": prompt_tokens + completion_tokens,
    }
    r = await _call("POST", f"/v1/enrich/jobs/{job_id}/submit", json=body)
    if r.status_code != 200:
        return _fail(r, "submit_enrichments")
    out = r.json()
    return f"Submitted {len(segments)} segment(s) for job={job_id} → status={out['status']}"


@mcp.tool()
async def classify_segment(
    text: str,
    tags: Optional[list[str]] = None,
) -> str:
    """Return the classifier prompt for a one-off snippet.

    The cloud doesn't run the LLM here — it returns the system prompt
    + the numbered lines so you (the connected agent) can run
    classification in your own context. Useful when you want to
    classify ad-hoc text without going through the document/job flow.
    Reply must be a JSON array of segments per the prompt's schema.
    """
    used_tags = tags or [
        "learn", "work", "life", "todo", "idea",
        "password", "reference", "others",
    ]
    tag_block = "\n".join(f"- {t}" for t in used_tags)
    lines = (text or "").splitlines() or [""]
    numbered = "\n".join(f"L{i + 1}: {ln}" for i, ln in enumerate(lines))
    return (
        "Classify the following lines into tag segments.\n\n"
        f"Available tags:\n{tag_block}\n\n"
        f"Lines:\n{numbered}\n\n"
        "Respond ONLY with a JSON array of segments shaped like "
        "{tag, secondary_tags, topic_name, line_start, line_end, "
        "summary, keywords, entities, is_credential}. "
        "Line numbers must be exact. Every line in exactly one segment."
    )


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
