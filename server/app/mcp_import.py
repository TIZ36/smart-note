"""MCP Document Import — fetch doc via MCP, AI rewrite to clean markdown, ingest.

Runs as a subprocess with progress streaming (like special_ingest).
Steps: fetch → rewrite → save → ingest
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

from app.config import settings


def _progress(step: str, current: int, total: int, detail: str):
    msg = {"step": step, "current": current, "total": total, "detail": detail}
    print(json.dumps(msg, ensure_ascii=False), file=sys.stderr, flush=True)


def _extract_feishu_doc_id(url: str) -> str:
    """Extract document ID from Feishu/Lark wiki/doc URL."""
    m = re.search(r'(?:wiki|docx|docs)/([A-Za-z0-9]+)', url)
    if m:
        return m.group(1)
    parts = [p for p in url.rstrip("/").split("/") if p]
    return parts[-1] if parts else ""


def _extract_title(content: str) -> str:
    """Extract document title from first meaningful line."""
    for line in content.split("\n"):
        stripped = line.strip().lstrip("# ").strip()
        if stripped and len(stripped) < 200:
            return stripped
    return ""


def _ai_rewrite_to_markdown(raw_content: str, title: str) -> str:
    """Send raw document content to LLM to produce clean, readable markdown."""
    from app.ai_enrich import _call_llm

    if not settings.provider_api_key:
        # No AI configured — return raw content with basic formatting
        return raw_content

    system = """You are a document formatter. Convert the raw document content into clean, well-structured Markdown.

RULES:
- Preserve ALL original content — do not summarize or remove anything
- Add proper Markdown headings (#, ##, ###) based on document structure
- Add paragraph breaks where appropriate
- Format lists, tables, and code blocks properly
- Keep the original language (do not translate)
- If the document has a title, use it as the top-level # heading
- Output ONLY the formatted Markdown, no explanations"""

    # Truncate very long documents for the AI call (keep structure)
    max_chars = 30000
    if len(raw_content) > max_chars:
        # Process in the first chunk, note that it's truncated
        user = f"Document title: {title}\n\n---\n\n{raw_content[:max_chars]}\n\n[... document continues, {len(raw_content) - max_chars} more characters ...]"
    else:
        user = f"Document title: {title}\n\n---\n\n{raw_content}"

    result = _call_llm(system, user)
    if result and len(result.strip()) > 100:
        return result.strip()

    # AI failed — return raw content
    return raw_content


def _new_format_id() -> str:
    import secrets, datetime as _dt
    return f"fmt_{_dt.datetime.now().strftime('%Y%m%d_%H%M%S')}_{secrets.token_hex(3)}"


def import_mcp_doc(
    server_name: str,
    doc_url: str = "",
    document_id: str = "",
    topic_name: str = "",
    ai_delegate: bool = False,
) -> dict:
    """Full MCP document import pipeline with progress streaming.

    Steps (normal):
    1. Fetch document via MCP
    2. AI rewrite to clean markdown
    3. Save .md file
    4. Ingest as wiki topic

    Delegate mode (ai_delegate=True):
    1. Fetch document via MCP
    2. Park raw content in `pending_format_docs` with a format_id
    3. Return early — caller (Claude) must submit the rewritten markdown via
       submit_enrichments(kind="doc_format", items=[{format_id, markdown}]),
       which triggers downstream ingest in delegate mode.
    """
    from app.mcp_client import mcp_call_tool
    from app.special_ingest import ingest_folder
    from app.db import connect

    # Step 1: Resolve document ID
    _progress("fetch", 0, 4, "Resolving document ID...")
    doc_id = document_id
    if not doc_id and doc_url:
        doc_id = _extract_feishu_doc_id(doc_url)
    if not doc_id:
        raise ValueError("Provide a document URL or document_id")

    # Step 2: Fetch via MCP
    _progress("fetch", 1, 4, f"Fetching document {doc_id[:12]}...")
    content = mcp_call_tool(
        server_name,
        "docx_v1_document_rawContent",
        {"path": {"document_id": doc_id}},
    )

    if not content or not content.strip():
        raise ValueError("MCP returned empty document content")

    raw_len = len(content)
    title = _extract_title(content)
    topic = topic_name or title or doc_id
    _progress("fetch", 2, 4, f"Fetched: {title or doc_id} ({raw_len} chars)")

    # Prepare output dir (same convention whether delegated or not)
    wiki_dir = Path(settings.wiki_sources_dir)
    wiki_dir.mkdir(parents=True, exist_ok=True)
    safe_name = re.sub(r'[^\w\s\u4e00-\u9fff-]', '_', topic)[:80]
    topic_dir = wiki_dir / safe_name
    topic_dir.mkdir(parents=True, exist_ok=True)
    md_path = topic_dir / f"{safe_name}.md"

    # Delegate path: park raw content, let Claude rewrite asynchronously
    if ai_delegate:
        format_id = _new_format_id()
        _progress("rewrite", 0, 1, "AI rewrite delegated to caller (MCP)...")
        with connect() as conn:
            conn.execute(
                """
                INSERT INTO pending_format_docs(format_id, topic_name, title, raw_content, source, target_dir, status)
                VALUES (?, ?, ?, ?, ?, ?, 'awaiting')
                """,
                (
                    format_id,
                    topic,
                    title,
                    content,
                    f"mcp:{server_name}:{doc_id}",
                    str(topic_dir),
                ),
            )
            conn.commit()
        _progress("done", 1, 1, f"Parked as {format_id} — awaiting Claude rewrite")
        return {
            "status": "awaiting_format",
            "format_id": format_id,
            "topic": topic,
            "title": title,
            "raw_length": raw_len,
            "target_dir": str(topic_dir),
            "source": f"mcp:{server_name}",
        }

    # Step 3: AI rewrite to clean markdown
    _progress("rewrite", 0, 1, "Rewriting to clean Markdown...")
    clean_md = _ai_rewrite_to_markdown(content, title)
    _progress("rewrite", 1, 1, f"Rewritten: {len(clean_md)} chars")

    # Step 4: Save .md file
    md_path.write_text(clean_md, encoding="utf-8")
    _progress("fetch", 3, 4, f"Saved: {md_path.name}")

    # Step 5: Ingest only this topic's directory
    _progress("fetch", 4, 4, "Starting ingest pipeline...")
    result = ingest_folder(str(topic_dir), topic_name=topic)

    return {
        **result,
        "md_path": str(md_path.resolve()),
        "title": title,
        "source": f"mcp:{server_name}",
    }
