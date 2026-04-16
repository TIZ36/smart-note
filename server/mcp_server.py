"""
SmartNote MCP Server — expose knowledge base to Claude Code / other AI tools.

Run with:
    python mcp_server.py              # default: http://localhost:8787
    python mcp_server.py --port 9000  # custom gateway port

Claude Code config (.mcp.json):
    {
      "mcpServers": {
        "smartnote": {
          "command": "server/.venv/bin/python",
          "args": ["server/mcp_server.py"]
        }
      }
    }
"""

import argparse
import hashlib
import json
import sys
import threading
import time
from typing import Any, Optional

import requests
from mcp.server.fastmcp import FastMCP


# ── E1: in-memory TTL cache for idempotent tool results ──
# Purely a latency/cost optimizer for cases where Claude re-queries the same
# thing within the same session (e.g. `list_tags`, `list_wiki_topics`,
# `list_pending_enrichments('summary')`). Does NOT cache mutating calls.
_TOOL_CACHE: dict[str, tuple[float, str]] = {}
_TOOL_CACHE_LOCK = threading.Lock()
_TOOL_CACHE_TTL = 60.0  # seconds — short so user-driven updates are reflected


def _cache_key(tool: str, args: dict) -> str:
    raw = tool + "::" + json.dumps(args, sort_keys=True, ensure_ascii=False, default=str)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:32]


def _cached(tool_name: str):
    """Decorator: cache tool results by argument signature for TTL seconds."""
    def wrap(fn):
        def inner(*args, **kwargs):
            key = _cache_key(tool_name, kwargs or {"args": args})
            now = time.time()
            with _TOOL_CACHE_LOCK:
                hit = _TOOL_CACHE.get(key)
                if hit and hit[0] > now:
                    return hit[1]
            result = fn(*args, **kwargs)
            with _TOOL_CACHE_LOCK:
                _TOOL_CACHE[key] = (now + _TOOL_CACHE_TTL, result)
            return result
        inner.__wrapped__ = fn
        inner.__name__ = fn.__name__
        return inner
    return wrap

# ── Gateway base URL ──
GATEWAY_URL = "http://localhost:8787"

mcp = FastMCP(
    "SmartNote",
    instructions=(
        "SmartNote is a personal knowledge base. Use these tools to search, ingest, "
        "and manage the user's notes and wiki topics. The search tool uses a 6-path hybrid "
        "retrieval system (FTS, substring, n-gram, vector, keyword + tag metadata). "
        "You can also trigger note ingestion, import wiki documents, and append content to notes."
    ),
)


def _api(method: str, path: str, timeout: int = 30, **kwargs) -> dict:
    """Call the SmartNote FastAPI gateway. GETs are cached for TTL seconds
    (keyed on path + query params) to short-circuit repeat read-only calls
    within a Claude session.
    """
    url = f"{GATEWAY_URL}{path}"
    cache_key = None
    if method.upper() == "GET":
        cache_key = _cache_key("GET " + path, kwargs.get("params", {}))
        with _TOOL_CACHE_LOCK:
            hit = _TOOL_CACHE.get(cache_key)
            if hit and hit[0] > time.time():
                return hit[1]
    try:
        resp = requests.request(method, url, timeout=timeout, **kwargs)
        resp.raise_for_status()
        data = resp.json()
        if cache_key:
            with _TOOL_CACHE_LOCK:
                _TOOL_CACHE[cache_key] = (time.time() + _TOOL_CACHE_TTL, data)
        elif method.upper() in ("POST", "DELETE", "PUT", "PATCH"):
            # Any mutation invalidates the whole GET cache — safer than
            # trying to pattern-match which reads are affected.
            _invalidate_cache()
        return data
    except requests.ConnectionError:
        return {"error": f"Cannot connect to SmartNote gateway at {GATEWAY_URL}. Is the server running?"}
    except requests.HTTPError as e:
        return {"error": f"HTTP {e.response.status_code}: {e.response.text[:500]}"}
    except Exception as e:
        return {"error": str(e)}


def _invalidate_cache():
    """Call after any mutating operation so stale GETs don't persist."""
    with _TOOL_CACHE_LOCK:
        _TOOL_CACHE.clear()


# ── Tool: Search knowledge base ──

@mcp.tool()
def search_knowledge(query: str, top_k: int = 10, tag_filter: Optional[str] = None) -> str:
    """Search the user's knowledge base (notes + wiki) using hybrid retrieval.

    Args:
        query: The search query (supports Chinese and English).
        top_k: Max number of results to return (default 10).
        tag_filter: Optional tag to filter by (e.g. "learn", "work", "todo", "password").
    """
    payload: dict[str, Any] = {"query": query, "topk": top_k}
    if tag_filter:
        payload["tag_filter"] = tag_filter

    data = _api("POST", "/search", json=payload)
    if "error" in data:
        return data["error"]

    results = data.get("results", [])
    if not results:
        return f"No results found for: {query}"

    lines = [f"Found {len(results)} results (latency: {data.get('latency_ms', '?')}ms):"]
    lines.append("")
    for i, r in enumerate(results[:top_k], 1):
        source = r.get("source_ref", "unknown")
        score = r.get("score", 0)
        is_wiki = r.get("is_wiki", False)
        prefix = "[wiki] " if is_wiki else ""
        text = r.get("text", "").strip()
        # Truncate very long chunks
        if len(text) > 400:
            text = text[:400] + "..."
        lines.append(f"### {i}. {prefix}{source} (score: {score:.3f})")
        lines.append(text)
        lines.append("")

    # Include wiki topics found
    wiki_topics = data.get("wiki_topics_found", {})
    if wiki_topics:
        lines.append("---")
        lines.append("Related wiki topics: " + ", ".join(wiki_topics.keys()))

    return "\n".join(lines)


# ── Tool: List tags ──

@mcp.tool()
def list_tags() -> str:
    """List all knowledge base tags with their segment counts and descriptions."""
    data = _api("GET", "/tags")
    if "error" in data:
        return data["error"]

    tags = data.get("tags", [])
    if not tags:
        return "No tags found."

    lines = ["Tags in knowledge base:"]
    for t in tags:
        name = t["name"]
        desc = t.get("desc", "")
        segs = t.get("segments", 0)
        total_lines = t.get("lines", 0)
        color = t.get("color", "")
        lines.append(f"- **{name}** ({segs} segments, {total_lines} lines) [{color}] — {desc}")
    return "\n".join(lines)


# ── Tool: Get segments by tag ──

@mcp.tool()
def get_tag_segments(tag_name: str) -> str:
    """Get all content segments classified under a specific tag.

    Args:
        tag_name: The tag name (e.g. "learn", "work", "todo", "password", "reminder").
    """
    data = _api("GET", f"/tags/{tag_name}")
    if "error" in data:
        return data["error"]

    segments = data.get("segments", [])
    if not segments:
        return f"No segments found for tag: {tag_name}"

    lines = [f"Segments tagged '{tag_name}' ({len(segments)} total):"]
    lines.append("")
    for s in segments[:30]:  # Limit to 30
        topic = s.get("topic_name", "")
        summary = s.get("summary", "")
        src = s.get("source_file", "")
        line_range = f"L{s.get('line_start', '?')}-{s.get('line_end', '?')}"
        lines.append(f"- [{topic or src}:{line_range}] {summary}")

    if len(segments) > 30:
        lines.append(f"\n... and {len(segments) - 30} more segments.")
    return "\n".join(lines)


# ── Tool: List wiki topics ──

@mcp.tool()
def list_wiki_topics() -> str:
    """List all special knowledge (wiki) topics imported into the knowledge base."""
    data = _api("GET", "/special-knowledge")
    if "error" in data:
        return data["error"]

    topics = data.get("topics", [])
    if not topics:
        return "No wiki topics found."

    lines = ["Wiki topics in knowledge base:"]
    for t in topics:
        name = t["topic"]
        summary = t.get("summary", "")
        category = t.get("category", "")
        created = t.get("created_at", "")
        lines.append(f"- **{name}** [{category}] — {summary} (added: {created})")
    return "\n".join(lines)


# ── Tool: Read source file content ──

@mcp.tool()
def read_source(source_ref: str) -> str:
    """Read the original source content around a specific reference (from search results).

    Args:
        source_ref: The source_ref string from a search result (e.g. "raw.md:line:5:line").
    """
    data = _api("GET", "/source", params={"ref": source_ref})
    if "error" in data:
        return data["error"]

    file_path = data.get("file", "unknown")
    target = data.get("target_line", 0)
    context_lines = data.get("lines", [])

    lines = [f"Source: {file_path} (target line: {target})", ""]
    for ln in context_lines:
        marker = ">>>" if ln.get("highlight") else "   "
        lines.append(f"{marker} {ln['line']:4d} | {ln['text']}")
    return "\n".join(lines)


# ── Tool: Knowledge graph ──

@mcp.tool()
def get_knowledge_graph() -> str:
    """Get the entity knowledge graph — nodes (entities) and edges (co-occurrence relationships)."""
    data = _api("GET", "/graph")
    if "error" in data:
        return data["error"]

    nodes = data.get("nodes", [])
    edges = data.get("edges", [])
    stats = data.get("stats", {})

    lines = [f"Knowledge Graph: {len(nodes)} entities, {len(edges)} relationships"]
    if stats:
        lines.append(f"Stats: {json.dumps(stats, ensure_ascii=False)}")
    lines.append("")

    # Top entities by mention count
    sorted_nodes = sorted(nodes, key=lambda n: n.get("mention_count", 0), reverse=True)
    lines.append("Top entities:")
    for n in sorted_nodes[:20]:
        etype = n.get("entity_type", "")
        mentions = n.get("mention_count", 0)
        lines.append(f"  - {n['name']} [{etype}] ({mentions} mentions)")

    if len(nodes) > 20:
        lines.append(f"  ... and {len(nodes) - 20} more entities.")

    return "\n".join(lines)


# ── Tool: Wiki knowledge graph ──

@mcp.tool()
def get_wiki_graph() -> str:
    """Get the wiki topic relationship graph — shows how wiki topics connect via shared keywords."""
    data = _api("GET", "/wiki-graph")
    if "error" in data:
        return data["error"]

    nodes = data.get("nodes", [])
    edges = data.get("edges", [])

    lines = [f"Wiki Graph: {len(nodes)} topics, {len(edges)} connections"]
    lines.append("")

    for n in nodes:
        name = n.get("name", "")
        summary = n.get("summary", "")
        chunks = n.get("chunk_count", 0)
        is_note = n.get("is_note", False)
        prefix = "[Notes] " if is_note else ""
        lines.append(f"- {prefix}{name} ({chunks} chunks) — {summary}")

    if edges:
        lines.append("")
        lines.append("Connections:")
        for e in edges[:20]:
            shared = ", ".join(e.get("shared_keywords", [])[:5])
            lines.append(f"  {e['source']} <-> {e['target']} (shared: {shared})")

    return "\n".join(lines)


# ── Tool: Search history ──

@mcp.tool()
def get_search_history() -> str:
    """Get recent search queries from the knowledge base (last 20)."""
    data = _api("GET", "/search/history")
    if "error" in data:
        return data["error"]

    history = data.get("history", [])
    if not history:
        return "No recent searches."

    lines = ["Recent searches:"]
    for h in history:
        q = h.get("query", "")
        count = h.get("result_count", 0)
        tag = h.get("tag_filter", "")
        ts = h.get("created_at", "")
        tag_info = f" [tag: {tag}]" if tag else ""
        lines.append(f"- \"{q}\"{tag_info} → {count} results ({ts})")
    return "\n".join(lines)


# ── Tool: Ingest notes ──

@mcp.tool()
def ingest_notes(reset: bool = False, delegate_enrich: bool = True) -> str:
    """Trigger ingestion of the user's raw notes into the knowledge base.

    SmartNote knows the configured raw note path — you don't pass it.

    MODES
    -----
    Incremental (reset=False, default):
      • Uses a per-file watermark (raw line count at last successful ingest).
      • New content appended past the watermark → new chunks inserted.
      • Content edits on already-ingested lines are detected by content-hash
        diff — changed chunks are deleted and re-inserted with empty dimension
        (pending re-classification). Prior tag segments are PRESERVED; only
        the altered line ranges appear in pending_line_ranges.
      • Line deletions set a `removed_refs` warning — existing tag segments
        covering the removed ranges may now be stale. `reset=True` cleans up.
      • Safe to call on a build that was enriched by Claude — existing
        `completed_by='mcp:delegate'` segments stay put; only new/edited
        ranges need classification.

    Reset (reset=True):
      • Full rebuild. Snapshots prior build then DELETEs all chunks +
        tag_segments for this source_file and creates a fresh build.
      • If the current active build's `completed_by` is 'mcp:delegate', a
        warning is printed to stderr and streamed via SSE; the wipe still
        proceeds (a pre-rebuild snapshot is taken for recovery).

    Delegation (delegate_enrich=True, default):
      Backend skips all LLM calls. Chunks are indexed for FTS/vector search
      but new/changed chunks land with `dimension=""`. Build status is
      `awaiting_enrich` until Claude submits via submit_enrichments.

      Recommended incremental follow-up:
        1. `list_pending_enrichments(kind='note_segments')` →
           returns `existing_segments` (preserve these), `pending_line_ranges`
           (classify these), and `incremental: true` when applicable.
        2. Read ONLY the pending line ranges from source_file.
        3. `submit_enrichments(kind='note_segments', items=[...])` with new
           segments only — don't re-emit existing ones.

    Set delegate_enrich=False to let the backend run its own DeepSeek
    enrichment (uses the Settings → Chat Provider API key).

    Args:
        reset: True = full rebuild from scratch. False (default) = incremental
            with edit detection.
        delegate_enrich: True (default) = skip backend ai_enrich; MCP caller
            fills in classifications.
    """
    # Read configured note path from SmartNote prefs
    prefs = _api("GET", "/prefs")
    raw_path = prefs.get("rawPath", "")
    if not raw_path:
        return (
            "ERROR: No note file configured in SmartNote. "
            "The user needs to open the SmartNote desktop app → Editor → choose a note file first. "
            "You cannot provide a path — SmartNote manages its own file locations."
        )

    # Derive note path by convention: same directory, note.md
    import os
    note_path = os.path.join(os.path.dirname(raw_path), "note.md")

    data = _api("POST", "/ingest", json={
        "raw_path": raw_path,
        "note_path": note_path,
        "reset": reset,
        "ai_delegate": bool(delegate_enrich),
    }, timeout=300)
    if "error" in data:
        return f"Ingest failed: {data['error']}"

    inserted = data.get("inserted", 0)
    segments = data.get("segments", 0)
    tags = data.get("tags", {})
    msg = data.get("message", "")
    mode = "rebuild" if reset else "incremental"
    delegated = bool(data.get("ai_delegated"))
    new_entries = int(data.get("new_entries", 0) or 0)
    changed_refs = int(data.get("changed_refs", 0) or 0)
    removed_refs = int(data.get("removed_refs", 0) or 0)
    warnings = data.get("warnings") or []

    lines = [f"Ingest complete ({mode}):"]
    lines.append(f"- {inserted} chunks inserted (new_entries={new_entries})")
    if mode == "incremental":
        lines.append(
            f"- watermark: {data.get('total_lines', '?')} raw lines "
            f"({data.get('non_empty_lines', '?')} non-empty)"
        )
        if changed_refs or removed_refs:
            lines.append(f"- edit detection: {changed_refs} changed, {removed_refs} removed refs")
    if segments:
        lines.append(f"- {segments} tag segments recorded")
    if tags:
        tag_str = ", ".join(f"{k}: {v}" for k, v in tags.items())
        lines.append(f"- Tags: {tag_str}")
    if msg:
        lines.append(f"- {msg}")
    for w in warnings:
        lines.append(f"- WARNING: {w}")
    if delegated:
        bid = data.get("build_id", "")
        sf = data.get("source_file", raw_path)
        tl = data.get("total_lines", 0)
        auto = data.get("auto_inherit") or {}
        lines.append("")
        if auto:
            hash_i = int(auto.get("hash_inherited", 0) or 0)
            cos_i = int(auto.get("cosine_inherited", 0) or 0)
            skipped = int(auto.get("skipped_lowsim", 0) or 0)
            merged = int(auto.get("merged", 0) or 0)
            if hash_i + cos_i > 0 or skipped > 0:
                lines.append(
                    f"Auto-classify: {hash_i} by hash + {cos_i} by cosine "
                    f"({auto.get('baseline', '?')} baseline); "
                    f"{skipped} remaining below threshold; merged {merged} segs."
                )
        if new_entries == 0:
            lines.append(
                f"No new or changed content. Build {bid} is already at watermark "
                f"{tl}. Nothing to enrich."
            )
        else:
            # Surface top meta-memories so Claude applies prior lessons.
            memory_hint = _fetch_meta_memory_hint()
            if memory_hint:
                lines.append(memory_hint)
            lines.append(
                f"AI enrichment delegated — build {bid} parked as awaiting_enrich.\n"
                f"Source: {sf} ({tl} raw lines, {new_entries} new/changed entries).\n"
                "Next steps:\n"
                "  1. `list_pending_enrichments(kind='note_segments')` — returns\n"
                "     `pending_line_ranges` (what to classify) and `existing_segments`\n"
                "     (preserve these; don't re-emit in incremental mode).\n"
                "  2. Read ONLY the pending ranges from source_file.\n"
                "  3. `submit_enrichments(kind='note_segments', items=[...])` — or\n"
                "     `items_file=<path>` for very large batches.\n"
                "Call `list_pending_enrichments('summary')` any time to see what's left."
            )
    return "\n".join(lines)


def _fetch_meta_memory_hint(limit: int = 5) -> str:
    """Fetch the top meta-memory entries and format as a hint block. Empty
    string when no memories (so callers can safely concat)."""
    try:
        data = _api("GET", "/meta-memory", params={"limit": limit})
        mems = data.get("memories", [])
        if not mems:
            return ""
        lines = ["📘 Meta-memory hints (past learnings — apply before classifying):"]
        for m in mems:
            lines.append(f"  • [{m['kind']}] {m['text']}")
        return "\n".join(lines)
    except Exception:
        return ""


@mcp.tool()
def classify_segment(
    source_file: str,
    line_start: int,
    line_end: int,
    tag: str,
    topic_name: str = "",
    summary: str = "",
    keywords: Optional[list[str]] = None,
    entities: Optional[list[dict]] = None,
    secondary_tags: Optional[list[str]] = None,
    is_credential: bool = False,
) -> str:
    """Classify a single line range in an already-ingested note file.

    Single-item escape hatch for refining an existing classification. For bulk
    classification after `ingest_notes(delegate_enrich=True)`, prefer
    `submit_enrichments(kind='note_segments', items=[...])` — one round-trip
    for the whole file instead of N calls.

    Args:
        source_file: Absolute path to the raw note file (returned in the ingest
            result as "source_file", or visible in tag_segments entries).
        line_start: 1-based inclusive line number where the topic starts.
        line_end: 1-based inclusive line number where the topic ends.
        tag: Primary tag name (e.g. "learn", "work", "todo", "password",
            "reminder"). Must be a tag the user has configured — use
            `list_tags()` first if unsure.
        topic_name: Short 1-3 word name (e.g. "Git Rebase", "OpenAI Keys").
        summary: One-line description of this segment.
        keywords: Optional list of keywords extracted from the segment.
        entities: Optional list of {"name": str, "type": str} dicts.
        secondary_tags: Additional tags for multi-tagging.
        is_credential: True if the segment contains secrets/passwords/API keys.
    """
    if line_end < line_start:
        return "ERROR: line_end must be >= line_start."
    if not tag or not tag.strip():
        return "ERROR: tag is required."
    payload = {
        "source_file": source_file,
        "line_start": int(line_start),
        "line_end": int(line_end),
        "tag": tag.strip(),
        "topic_name": topic_name or "",
        "summary": summary or "",
        "keywords": keywords or [],
        "entities": entities or [],
        "secondary_tags": secondary_tags or [],
        "is_credential": bool(is_credential),
    }
    data = _api("POST", "/tag-segments/classify", json=payload, timeout=30)
    if "error" in data:
        return f"Classification failed: {data['error']}"
    return (
        f"Classified L{line_start}-L{line_end} as '{tag}'"
        f" (retagged {data.get('chunks_retagged', 0)} chunks)."
    )


# ── Tool: Delegate enrichment queue ──

@mcp.tool()
def list_pending_enrichments(
    kind: str = "summary",
    build_id: str = "",
    limit: int = 100,
    offset: int = 0,
) -> str:
    """Discover ingest artifacts that were parked in delegate mode and need
    LLM work (tag segments, chunk summaries, topic summaries, or raw-doc
    markdown rewrite).

    Workflow: call with kind='summary' first to see what's pending across all
    kinds. Then call with a specific kind to get the actual items. Then submit
    via `submit_enrichments`.

    Incremental semantics for kind='note_segments':
      • `incremental: true` means the build already has some classified
        segments from a prior run — you should only enrich `pending_line_ranges`
        and PRESERVE everything in `existing_segments` (don't re-emit them).
      • `incremental: false` means a fresh build — decide segments for the
        whole file.
      • `pending_line_ranges` is the list of [line_start, line_end] groups
        where chunks have no tag yet; coalesced by ≤2-line gaps.

    Args:
        kind: one of 'summary' (default overview), 'note_segments',
            'wiki_chunks', 'wiki_topic', 'doc_format'.
        build_id: optional — restrict to a single build.
        limit: page size (1-500, default 100).
        offset: pagination offset (default 0).
    """
    params: dict[str, Any] = {"kind": kind, "limit": limit, "offset": offset}
    if build_id:
        params["build_id"] = build_id
    data = _api("GET", "/enrich-queue", params=params)
    if "error" in data:
        return data["error"]
    # Surface meta-memory at the entries Claude visits before enrichment.
    hint = ""
    if kind in ("summary", "note_segments"):
        hint = _fetch_meta_memory_hint()
    payload = json.dumps(data, ensure_ascii=False, indent=2)
    return (hint + "\n\n" + payload) if hint else payload


@mcp.tool()
def submit_enrichments(
    kind: str,
    items: Optional[list[dict]] = None,
    items_file: Optional[str] = None,
) -> str:
    """Submit a batch of enrichments for parked delegate-mode artifacts.

    For LARGE batches (dozens of items), prefer `items_file` — you can
    generate the list via a subagent or Write tool, save to a local file,
    and pass the path. The backend reads from disk, avoiding the cost of
    you token-generating a huge JSON payload inline.

    Item shape per kind (each item is a dict; see below):
      - kind='note_segments':
          {source_file, line_start, line_end, tag,
           topic_name?, summary?, keywords?, entities?,
           secondary_tags?, is_credential?}
      - kind='wiki_chunks':
          {chunk_id, summary, keywords?, entities?}
          summary is required (1 sentence, <30 words).
      - kind='wiki_topic':
          {tag_segment_id, summary, keywords?}
          summary is a 2-3 sentence description of the whole topic.
      - kind='doc_format':
          {format_id, markdown}
          Submitting triggers a delegated wiki ingest of the rewritten .md
          (wiki_chunks + wiki_topic will then appear as pending).

    Args:
        kind: one of 'note_segments', 'wiki_chunks', 'wiki_topic', 'doc_format'.
        items: inline list of item dicts (supply this OR items_file).
        items_file: absolute path to a local .json (JSON array) or .jsonl
            (newline-delimited JSON) file. When provided, backend reads and
            merges with `items`.

    After submitting, call `list_pending_enrichments('summary')` to see
    what's left.
    """
    if not kind or not kind.strip():
        return "ERROR: kind is required."
    if not items and not items_file:
        return "ERROR: provide items (inline list) or items_file (path)."
    payload: dict[str, Any] = {"kind": kind.strip(), "items": items or []}
    if items_file:
        payload["items_file"] = items_file
    data = _api("POST", "/enrich-bulk", json=payload, timeout=120)
    if "error" in data:
        return f"Submit failed: {data['error']}"
    applied = data.get("applied", 0)
    failed = data.get("failed", [])
    build_status = data.get("build_status_after", {})
    chained = data.get("chained_ingests", [])
    lines = [f"Submitted {kind}: {applied} applied, {len(failed)} failed"]
    if failed:
        lines.append("Failures:")
        for f in failed[:10]:
            lines.append(f"  - idx {f.get('index')}: {f.get('error')}")
    if build_status:
        lines.append("Build status after:")
        for bid, status in build_status.items():
            lines.append(f"  - {bid}: {status}")
    if chained:
        lines.append("Chained wiki ingests:")
        for c in chained:
            if c.get("ingest_error"):
                lines.append(f"  - {c.get('format_id')}: ERROR {c['ingest_error']}")
            else:
                lines.append(
                    f"  - {c.get('format_id')}: topic='{c.get('topic')}', "
                    f"build={c.get('build_id')}, {c.get('inserted', 0)} chunks pending enrich"
                )
    return "\n".join(lines)


# ── Tool: Knowledge gaps (search misses) ──

@mcp.tool()
def list_knowledge_gaps(limit: int = 20) -> str:
    """Queries the user has searched but the knowledge base couldn't answer
    well (empty results or weak top score). A proactive signal of what
    content is missing — consider calling `import_wiki_doc(...)` to fill
    the most recurring gaps.

    Args:
        limit: max number of gap queries to return (default 20).
    """
    data = _api("GET", "/search/gaps", params={"limit": limit})
    if "error" in data:
        return data["error"]
    gaps = data.get("gaps", [])
    if not gaps:
        return "No recurring knowledge gaps detected — searches are returning decent hits."
    lines = [f"Recurring knowledge gaps ({len(gaps)}):"]
    for g in gaps:
        lines.append(
            f"- \"{g['query']}\"  ×{g['miss_count']}  "
            f"(top_score={g['avg_top_score']}, last={g['last_seen']})"
        )
    return "\n".join(lines)


# ── Tool: Meta-memory (Claude's own cross-session learnings) ──

@mcp.tool()
def read_meta_memory(limit: int = 100) -> str:
    """Return the session-persistent learnings that past Claude sessions
    wrote about this knowledge base.

    Call this at the START of a session (and before enrichment) to apply
    prior lessons — e.g. domain vocabulary the user uses, preferred tag
    conventions, gotchas learned from past mistakes.

    Args:
        limit: max memories to return (default 100, sorted by hit_count desc).
    """
    data = _api("GET", "/meta-memory", params={"limit": limit})
    if "error" in data:
        return data["error"]
    mems = data.get("memories", [])
    if not mems:
        return "(empty) No meta-memories yet. Consider calling append_meta_memory with useful learnings from this session."
    lines = [f"Meta-memory ({len(mems)} entries):"]
    for m in mems:
        lines.append(f"- [{m['kind']}/{m['scope']}] {m['text']} (hits={m['hit_count']})")
    return "\n".join(lines)


@mcp.tool()
def append_meta_memory(text: str, kind: str = "rule", scope: str = "global") -> str:
    """Save a learning that should persist across sessions (Claude's own
    notes about this knowledge base).

    Good candidates:
      - Domain vocabulary the user uses (e.g. "'回传 SQL' usually means v2_callback_sub_strategy, not callback_config")
      - Tag conventions ("hobby tag is reserved for actual hobbies, not tech side-projects — those go to learn")
      - Gotchas from past mistakes
      - User preferences about style/verbosity

    Do NOT use for:
      - Session-local state (use the conversation itself)
      - Raw notes content (use append_to_note or import_wiki_doc)
      - Credentials (the `password` tag handles those)

    Args:
        text: the learning (1-2 sentences, imperative tense preferred).
        kind: 'rule' | 'vocab' | 'preference' | 'gotcha' (free-form).
        scope: 'global' or a specific tag/topic (e.g. 'work', 'wiki:回传SOP').
    """
    text = (text or "").strip()
    if not text:
        return "ERROR: text is required."
    data = _api("POST", "/meta-memory", json={
        "text": text, "kind": kind, "scope": scope,
    })
    if "error" in data:
        return f"Failed: {data['error']}"
    if data.get("deduped"):
        return f"Deduplicated (already exists). hit_count bumped on id={data['id']}."
    return f"Saved as id={data['id']}."


@mcp.tool()
def forget_meta_memory(memory_id: int) -> str:
    """Remove a meta-memory entry that's outdated or wrong."""
    data = _api("DELETE", f"/meta-memory/{memory_id}")
    if "error" in data:
        return data["error"]
    return f"Deleted memory id={data.get('deleted', memory_id)}."


# ── Tool: Conflicts (C1) ──

@mcp.tool()
def list_conflicts() -> str:
    """List enrichment conflicts that need human adjudication — cases where
    two sessions assigned different tags to the same line range. Resolve
    via `resolve_conflict(conflict_id, choice)` where choice is
    'keep_existing', 'accept_incoming', or 'dismiss'."""
    data = _api("GET", "/conflicts")
    if "error" in data:
        return data["error"]
    conflicts = data.get("conflicts", [])
    if not conflicts:
        return "No conflicts pending."
    lines = [f"Pending conflicts ({len(conflicts)}):"]
    for c in conflicts:
        lines.append(
            f"- #{c['id']} L{c['line_start']}-{c['line_end']}  "
            f"existing={c['existing_tag']} vs incoming={c['incoming_tag']}  "
            f"({c['source_file'].rsplit('/', 1)[-1]})"
        )
    return "\n".join(lines)


@mcp.tool()
def resolve_conflict(conflict_id: int, choice: str) -> str:
    """Resolve a conflict by choosing which tag to keep.

    Args:
        conflict_id: id from `list_conflicts`.
        choice: 'keep_existing' | 'accept_incoming' | 'dismiss'.
    """
    if choice not in ("keep_existing", "accept_incoming", "dismiss"):
        return "ERROR: choice must be 'keep_existing', 'accept_incoming', or 'dismiss'."
    data = _api("POST", "/conflicts/resolve", json={
        "conflict_id": conflict_id, "choice": choice,
    })
    if "error" in data:
        return data["error"]
    return f"Resolved conflict {data.get('resolved')} with choice={data.get('choice')}."


# ── Tool: Segment split suggestions (C2) ──

@mcp.tool()
def list_split_suggestions(min_lines: int = 200, min_subheadings: int = 3) -> str:
    """Find segments that are probably too broad (over min_lines and contain
    >= min_subheadings markdown sub-headings) — candidates for Claude to
    re-classify into finer sub-topics."""
    data = _api("GET", "/segments/split-suggestions", params={
        "min_lines": min_lines, "min_subheadings": min_subheadings,
    })
    if "error" in data:
        return data["error"]
    suggestions = data.get("suggestions", [])
    if not suggestions:
        return "No over-broad segments detected."
    lines = [f"Split candidates ({len(suggestions)}):"]
    for s in suggestions:
        lines.append(
            f"- seg #{s['segment_id']}  [{s['tag']}/{s['topic_name']}]  "
            f"L{s['line_start']}-{s['line_end']} ({s['line_count']} lines, "
            f"{len(s['subheadings_at'])} subheadings: {s['subheadings_at'][:4]}...)"
        )
    return "\n".join(lines)


# ── Tool: Observability dashboard (D1) ──

@mcp.tool()
def get_dashboard() -> str:
    """One-shot overview: chunk/segment counts, build attribution, answer-cache
    hits, accumulated cost, recent gaps, top-trust chunks. Useful to see
    how the feedback loops are compounding over time."""
    data = _api("GET", "/dashboard/overview")
    if "error" in data:
        return data["error"]
    lines = ["📊 SmartNote Dashboard", ""]
    lines.append("Counts:")
    for k, v in data.get("counts", {}).items():
        lines.append(f"  {k}: {v}")
    lines.append("")
    lines.append("Build attribution:")
    for k, v in data.get("build_attribution", {}).items():
        lines.append(f"  {k or '(unspecified)'}: {v}")
    ac = data.get("answer_cache") or {}
    lines.append("")
    lines.append(f"Answer cache: {ac.get('entries', 0)} entries, "
                 f"{ac.get('total_hits', 0)} total hits")
    lines.append(f"Total cost (CNY): {data.get('total_cost_cny', 0):.2f}")
    gaps = data.get("recent_gaps") or []
    if gaps:
        lines.append("")
        lines.append("Top 7-day gaps:")
        for g in gaps:
            lines.append(f"  - \"{g['query_text']}\" ×{g['c']}")
    tt = data.get("trust_top_chunks") or []
    if tt:
        lines.append("")
        lines.append("Top trust chunks:")
        for c in tt:
            lines.append(f"  - #{c['id']}  trust={c['trust_score']}  {c['source_ref']}")
    return "\n".join(lines)


# ── Tool: OCR processing trigger (C4) ──

@mcp.tool()
def process_pending_ocr(limit: int = 20) -> str:
    """Run tesseract on queued image references (best-effort; requires local
    tesseract install). Refs were auto-queued during ingest."""
    data = _api("POST", "/ocr/process", params={"limit": limit})
    if "error" in data:
        return data["error"]
    if data.get("error"):
        return f"OCR skipped: {data['error']}"
    return f"Processed {data.get('processed', 0)} ({data.get('failed', 0)} failed)."


# ── Tool: Import wiki document ──

@mcp.tool()
def import_wiki_doc(
    topic_name: str,
    content: Optional[str] = None,
    url: Optional[str] = None,
    local_path: Optional[str] = None,
    delegate_enrich: bool = True,
) -> str:
    """Import a document as a wiki topic into SmartNote's knowledge base.

    Provide the document in ONE of three ways (pick one):
    1. content — pass the full markdown text directly (best for generated or small docs)
    2. url — a web URL; SmartNote will fetch and convert to markdown
    3. local_path — absolute path to a local .md, .txt, .pdf file or folder

    The document will be stored in SmartNote's iCloud wiki directory and indexed.

    AI enrichment delegation (delegate_enrich=True, default):
      Backend skips ai_enrich: chunks get no LLM summary/keywords/entities,
      the topic-level tag_segment is created with empty summary, and the
      build is parked with enrich_status='awaiting_enrich'. Discover pending
      work via `list_pending_enrichments('summary')` and fill it in via
      `submit_enrichments(kind='wiki_chunks'|'wiki_topic', items=[...])`.
      Set to False to let the backend enrich with its configured provider.

    Args:
        topic_name: A short, descriptive name for this wiki topic (e.g. "React Hooks Guide").
        content: Full markdown text of the document. Use this when you have the text already.
        url: A web URL to fetch (e.g. "https://example.com/doc"). SmartNote converts HTML → markdown.
        local_path: Absolute path to a local file (.md/.txt/.pdf) or folder.
        delegate_enrich: If True (default), skip backend ai_enrich.
    """
    # Validate: exactly one source provided
    sources = sum(1 for s in [content, url, local_path] if s)
    if sources == 0:
        return (
            "ERROR: No document provided. You must supply exactly ONE of:\n"
            "  - content: the full markdown text (pass it directly as a string)\n"
            "  - url: a web URL that SmartNote will fetch\n"
            "  - local_path: absolute path to a .md/.txt/.pdf file or folder on this machine\n\n"
            "Example: import_wiki_doc(topic_name='My Doc', content='# Title\\nContent here...')"
        )
    if sources > 1:
        return (
            "ERROR: Multiple sources provided. Pass exactly ONE of: content, url, or local_path.\n"
            "Do not combine them."
        )

    if not topic_name or not topic_name.strip():
        return "ERROR: topic_name is required. Provide a short descriptive name (e.g. 'React Hooks Guide')."

    # ── Option 1: Direct content ──
    if content:
        import os, re
        safe = re.sub(r'[^\w\s\u4e00-\u9fff-]', '_', topic_name.strip())[:80]
        wiki_dir = os.environ.get(
            "WIKI_SOURCES_DIR",
            os.path.expanduser("~/Library/Mobile Documents/com~apple~CloudDocs/sn/source"),
        )
        topic_dir = os.path.join(wiki_dir, safe)
        os.makedirs(topic_dir, exist_ok=True)
        md_path = os.path.join(topic_dir, f"{safe}.md")
        with open(md_path, "w", encoding="utf-8") as f:
            f.write(content.strip() + "\n")

        data = _api("POST", "/special-ingest", json={
            "folder_path": topic_dir,
            "topic_name": topic_name.strip(),
            "ai_delegate": bool(delegate_enrich),
        }, timeout=300)

        if "error" in data:
            return f"Import failed: {data['error']}"
        inserted = data.get("inserted", 0)
        return f"Wiki imported: '{topic_name}' — {inserted} chunks indexed from direct content ({len(content)} chars)"

    # ── Option 2: URL ──
    if url:
        data = _api("POST", "/wiki/import-url", json={
            "url": url,
            "topic_name": topic_name.strip(),
            "ai_delegate": bool(delegate_enrich),
        }, timeout=300)

        if "error" in data:
            return f"Import failed: {data['error']}"
        inserted = data.get("inserted", 0)
        return f"Wiki imported: '{topic_name}' — {inserted} chunks indexed from URL: {url}"

    # ── Option 3: Local path ──
    if local_path:
        import os
        from pathlib import Path as P

        path = P(local_path)
        if not path.exists():
            return (
                f"ERROR: Path not found: {local_path}\n"
                "Provide an absolute path to a file or folder on this machine.\n"
                "If you have the document text, use the 'content' parameter instead."
            )

        if path.is_file() and path.suffix.lower() in (".md", ".txt", ".pdf"):
            import re, shutil
            safe = re.sub(r'[^\w\s\u4e00-\u9fff-]', '_', topic_name.strip())[:80]
            wiki_dir = os.environ.get(
                "WIKI_SOURCES_DIR",
                os.path.expanduser("~/Library/Mobile Documents/com~apple~CloudDocs/sn/source"),
            )
            topic_dir = os.path.join(wiki_dir, safe)
            os.makedirs(topic_dir, exist_ok=True)
            shutil.copy2(str(path), os.path.join(topic_dir, path.name))

            data = _api("POST", "/special-ingest", json={
                "folder_path": topic_dir,
                "topic_name": topic_name.strip(),
                "ai_delegate": bool(delegate_enrich),
            }, timeout=300)
        elif path.is_dir():
            data = _api("POST", "/special-ingest", json={
                "folder_path": str(path),
                "topic_name": topic_name.strip(),
                "ai_delegate": bool(delegate_enrich),
            }, timeout=300)
        else:
            return (
                f"ERROR: Unsupported file type: {path.suffix}\n"
                "Supported: .md, .txt, .pdf, or a folder containing these.\n"
                "If you have the text, use the 'content' parameter instead."
            )

        if "error" in data:
            return f"Import failed: {data['error']}"
        inserted = data.get("inserted", 0)
        files = data.get("files", 0)
        return f"Wiki imported: '{topic_name}' — {inserted} chunks from {files} files"

    return "ERROR: Unexpected state. Provide content, url, or local_path."


# ── Tool: Append content to note ──

@mcp.tool()
def append_to_note(content: str) -> str:
    """Append new content to the user's raw note file (synced to iCloud).

    SmartNote automatically knows which note file to append to (configured in the desktop app).
    Use this to add meeting notes, thoughts, bookmarks, or any text the user wants to save.
    After appending, call ingest_notes() to index the new content for search.

    Args:
        content: The text to append (markdown supported). Will be added at the end of the file.
    """
    if not content or not content.strip():
        return "ERROR: No content provided. Pass the text you want to append as the 'content' parameter."

    # Read configured note path from SmartNote prefs
    prefs = _api("GET", "/prefs")
    raw_path = prefs.get("rawPath", "")
    if not raw_path:
        return (
            "ERROR: No note file configured in SmartNote. "
            "The user needs to open SmartNote desktop app → Editor → choose a note file first. "
            "You cannot provide a path — SmartNote manages its own file locations."
        )

    data = _api("POST", "/note/append", json={
        "raw_path": raw_path,
        "content": content,
    })
    if "error" in data:
        return f"Append failed: {data['error']}"

    size = data.get("bytes_written", 0)
    return f"Appended {size} bytes to note. Call ingest_notes() to index the new content for search."


# ── Main ──

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="SmartNote MCP Server")
    parser.add_argument("--port", type=int, default=8787, help="SmartNote gateway port")
    args = parser.parse_args()
    GATEWAY_URL = f"http://localhost:{args.port}"

    mcp.run()
