"""Special Knowledge Ingest — folder → specialknowledge tag → single topic.

Reads all supported files from a folder, chunks them, and ingests
as a single topic under the "specialknowledge" tag. Appends to the
active build (incremental, not a new build).

Use case: user references a paper/codebase/doc set in their notes,
and wants the AI to have access to that material for answering.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

from app.builds import get_active_build_id, create_build
from app.db import connect
from app.embed import embed_texts
from app.tokenizer import segment

# Supported file extensions
TEXT_EXTENSIONS = {
    ".md", ".txt", ".rst", ".org",  # Markdown/text
    ".py", ".js", ".ts", ".jsx", ".tsx", ".go", ".rs", ".java", ".c", ".cpp", ".h",  # Code
    ".json", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf",  # Config
    ".sh", ".bash", ".zsh",  # Shell
    ".sql",  # SQL
    ".html", ".css", ".xml", ".csv",  # Web/data
    ".log", ".env.example",  # Other
}

MAX_CHUNK_CHARS = 300


def _progress(step: str, current: int, total: int, detail: str):
    msg = {"step": step, "current": current, "total": total, "detail": detail}
    print(json.dumps(msg, ensure_ascii=False), file=sys.stderr, flush=True)


def _read_file_safe(path: Path) -> str:
    """Read a file, skip binary/unreadable files."""
    try:
        content = path.read_text(encoding="utf-8", errors="ignore")
        # Skip if looks binary (too many null bytes)
        if "\x00" in content[:1000]:
            return ""
        return content
    except Exception:
        return ""


def _chunk_text(text: str, source_name: str, max_len: int = MAX_CHUNK_CHARS) -> list[dict]:
    """Split text into chunks with source attribution."""
    lines = text.splitlines()
    chunks = []
    buf = []
    buf_len = 0
    start_line = 1

    for i, line in enumerate(lines, 1):
        buf.append(line)
        buf_len += len(line) + 1
        if buf_len >= max_len:
            content = "\n".join(buf).strip()
            if content:
                chunks.append({
                    "text": content,
                    "source_ref": f"{source_name}:line:{start_line}-{i}",
                    "line_start": start_line,
                    "line_end": i,
                })
            buf = []
            buf_len = 0
            start_line = i + 1

    # Remaining buffer
    if buf:
        content = "\n".join(buf).strip()
        if content:
            chunks.append({
                "text": content,
                "source_ref": f"{source_name}:line:{start_line}-{start_line + len(buf) - 1}",
                "line_start": start_line,
                "line_end": start_line + len(buf) - 1,
            })

    return chunks


def ingest_folder(folder_path: str, topic_name: str | None = None) -> dict:
    """Ingest all supported files in a folder as a single specialknowledge topic.

    Args:
        folder_path: path to the folder to ingest
        topic_name: custom topic name (defaults to folder name)

    Returns:
        dict with inserted count, file count, message
    """
    folder = Path(folder_path)
    if not folder.is_dir():
        raise FileNotFoundError(f"Folder not found: {folder_path}")

    # Topic name defaults to folder name
    if not topic_name:
        topic_name = folder.name

    _progress("parse", 0, 0, f"Scanning folder: {folder.name}")

    # Collect all supported files recursively
    files: list[Path] = []
    for ext in TEXT_EXTENSIONS:
        files.extend(folder.rglob(f"*{ext}"))
    # Also include extensionless files if they look like text
    for f in folder.rglob("*"):
        if f.is_file() and f.suffix == "" and f.name not in {".", ".."} and not f.name.startswith("."):
            files.append(f)

    files = sorted(set(files))
    _progress("parse", 0, len(files), f"Found {len(files)} files")

    if not files:
        return {"inserted": 0, "files": 0, "message": "No supported files found in folder."}

    # Read and chunk all files
    all_chunks: list[dict] = []
    for i, f in enumerate(files):
        rel = f.relative_to(folder)
        content = _read_file_safe(f)
        if not content.strip():
            continue
        file_chunks = _chunk_text(content, str(rel))
        for chunk in file_chunks:
            chunk["source_file"] = str(f)
        all_chunks.extend(file_chunks)
        if (i + 1) % 10 == 0 or i + 1 == len(files):
            _progress("parse", i + 1, len(files), f"{i + 1}/{len(files)} files, {len(all_chunks)} chunks")

    total = len(all_chunks)
    if total == 0:
        return {"inserted": 0, "files": len(files), "message": "Files contained no text content."}

    _progress("parse", len(files), len(files), f"{len(files)} files → {total} chunks")

    # Get or create active build
    build_id = get_active_build_id() or create_build(folder_path)

    # Embed all chunks
    _progress("embed", 0, total, "Generating embeddings...")
    texts = [c["text"] for c in all_chunks]
    vectors = embed_texts(texts)
    _progress("embed", total, total, "Embeddings done")

    # Segment with jieba
    _progress("segment", 0, total, "Segmenting text...")
    segmented = [segment(t) for t in texts]
    _progress("segment", total, total, "Segmentation done")

    # Store chunks
    _progress("store", 0, total, "Storing chunks...")
    inserted = 0
    with connect() as conn:
        for idx, chunk in enumerate(all_chunks):
            seg_tokens = segmented[idx].split()
            keywords = [t for t in seg_tokens if len(t) > 1]

            conn.execute(
                """
                INSERT INTO chunks(build_id, source_file, source_ref, text, text_segmented,
                  dimension, project_slug, embedding_json, keywords_json, entities_json, ai_summary)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    build_id,
                    chunk["source_file"],
                    chunk["source_ref"],
                    chunk["text"],
                    segmented[idx],
                    f"spkn:{topic_name}",
                    None,
                    json.dumps(vectors[idx]),
                    json.dumps(keywords, ensure_ascii=False),
                    "[]",
                    "",
                ),
            )
            inserted += 1

            if (idx + 1) % 50 == 0 or idx + 1 == total:
                _progress("store", idx + 1, total, f"Stored {idx + 1}/{total}")

        # Create a tag_segment covering the entire topic
        conn.execute(
            """
            INSERT INTO tag_segments(build_id, source_file, tag, topic_name, line_start, line_end, summary, keywords_json, entities_json, is_credential)
            VALUES (?, ?, ?, ?, 1, ?, ?, '[]', '[]', 0)
            """,
            (
                build_id,
                folder_path,
                f"spkn:{topic_name}",
                topic_name,
                total,
                f"Special knowledge: {topic_name} ({len(files)} files, {total} chunks)",
            ),
        )

        conn.commit()

    summary = f"Ingested {inserted} chunks from {len(files)} files as topic '{topic_name}'"
    _progress("done", inserted, total, summary)

    return {
        "inserted": inserted,
        "files": len(files),
        "topic": topic_name,
        "message": summary,
    }
