"""
IntelliNote MCP Server — expose knowledge base to Claude Code / OpenCode.

Run with:
    python mcp_server.py              # default: http://localhost:8787
    python mcp_server.py --port 9000  # custom gateway port

Claude Code config (~/.claude.json or project .mcp.json):
    {
      "mcpServers": {
        "intellinote": {
          "command": "python",
          "args": ["/path/to/mvp/mcp_server.py"]
        }
      }
    }
"""

import argparse
import json
import sys
from typing import Any, Optional

import requests
from mcp.server.fastmcp import FastMCP

# ── Gateway base URL ──
GATEWAY_URL = "http://localhost:8787"

mcp = FastMCP(
    "IntelliNote",
    instructions=(
        "IntelliNote is a personal knowledge base. Use these tools to search the user's notes, "
        "wiki topics, and tagged knowledge segments. The search tool uses a 5-path hybrid "
        "retrieval system (FTS, substring, n-gram, vector, keyword + tag metadata). "
        "Always search before answering questions about the user's knowledge."
    ),
)


def _api(method: str, path: str, **kwargs) -> dict:
    """Call the IntelliNote FastAPI gateway."""
    url = f"{GATEWAY_URL}{path}"
    try:
        resp = requests.request(method, url, timeout=30, **kwargs)
        resp.raise_for_status()
        return resp.json()
    except requests.ConnectionError:
        return {"error": f"Cannot connect to IntelliNote gateway at {GATEWAY_URL}. Is the server running?"}
    except requests.HTTPError as e:
        return {"error": f"HTTP {e.response.status_code}: {e.response.text[:500]}"}
    except Exception as e:
        return {"error": str(e)}


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


# ── Main ──

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="IntelliNote MCP Server")
    parser.add_argument("--port", type=int, default=8787, help="IntelliNote gateway port")
    args = parser.parse_args()
    GATEWAY_URL = f"http://localhost:{args.port}"

    mcp.run()
