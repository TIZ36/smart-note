"""URL → Markdown import for wiki.

Fetches a URL, converts HTML to markdown via markitdown, saves as .md.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from urllib.parse import urlparse


def _progress(step: str, current: int, total: int, detail: str):
    msg = {"step": step, "current": current, "total": total, "detail": detail}
    print(json.dumps(msg, ensure_ascii=False), file=sys.stderr, flush=True)


def import_url(url: str, output_dir: str, topic_name: str | None = None) -> dict:
    """Fetch a URL and convert to markdown.

    Args:
        url: the URL to fetch
        output_dir: directory to save the .md file
        topic_name: custom topic name (defaults to page title or domain)

    Returns:
        dict with md_path, topic_name, char_count
    """
    from markitdown import MarkItDown

    parsed = urlparse(url)
    if not topic_name:
        # Use last path segment or domain as topic name
        path_parts = [p for p in parsed.path.strip("/").split("/") if p]
        topic_name = path_parts[-1] if path_parts else parsed.netloc
        topic_name = re.sub(r'[^\w\s\u4e00-\u9fff-]', '', topic_name).strip() or parsed.netloc

    _progress("parse", 0, 1, f"Fetching: {url}")

    md = MarkItDown(enable_plugins=False)
    result = md.convert(url)
    text = (result.text_content or "").strip()

    if not text:
        raise ValueError(f"No content extracted from URL: {url}")

    # Save to per-topic subdirectory (avoids ingesting other topics' files)
    safe_name = re.sub(r'[^\w\s\u4e00-\u9fff-]', '_', topic_name)[:80]
    topic_dir = Path(output_dir) / safe_name
    topic_dir.mkdir(parents=True, exist_ok=True)
    md_path = topic_dir / f"{safe_name}.md"

    # Add source URL as frontmatter
    content = f"<!-- source: {url} -->\n\n{text}"
    md_path.write_text(content, encoding="utf-8")

    _progress("parse", 1, 1, f"Saved: {md_path.name} ({len(text)} chars)")

    return {
        "md_path": str(md_path),
        "topic_name": topic_name,
        "char_count": len(text),
    }
