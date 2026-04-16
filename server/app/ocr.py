"""OCR pipeline for inline image references in notes (C4).

Markdown-ish references like `![image](path)` or `![image.png](attachment:...)`
are otherwise invisible to retrieval. This module:

1. `scan_image_refs(text)` — regex-extract (line_no, image_ref) pairs.
2. `enqueue_pending_ocr(source_file, refs)` — insert into `ocr_pending`.
3. `process_pending_ocr()` — attempt tesseract on local paths; mark status.

Tesseract is optional: if not installed, status stays 'pending' and the
refs just don't contribute to search. Graceful degradation.
"""

from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path

from app.db import connect


# ![alt](path) or ![alt](attachment:blob:...)
_IMG_REF_RE = re.compile(r"!\[[^\]]*\]\(([^)]+)\)")


def scan_image_refs(text: str) -> list[tuple[int, str]]:
    """Return (line_no_1based, image_ref) pairs."""
    refs: list[tuple[int, str]] = []
    for line_no, line in enumerate(text.splitlines(), start=1):
        for m in _IMG_REF_RE.finditer(line):
            ref = m.group(1).strip()
            if not ref:
                continue
            refs.append((line_no, ref))
    return refs


def enqueue_pending_ocr(source_file: str, refs: list[tuple[int, str]]) -> int:
    """Insert OCR requests for refs that aren't already tracked."""
    if not refs:
        return 0
    added = 0
    with connect() as conn:
        for line_no, ref in refs:
            existing = conn.execute(
                "SELECT id FROM ocr_pending WHERE source_file = ? "
                "AND line_no = ? AND image_ref = ?",
                (source_file, line_no, ref),
            ).fetchone()
            if existing:
                continue
            conn.execute(
                "INSERT INTO ocr_pending(source_file, line_no, image_ref) "
                "VALUES (?, ?, ?)",
                (source_file, line_no, ref),
            )
            added += 1
        conn.commit()
    return added


def _resolve_image_path(source_file: str, ref: str) -> Path | None:
    """Return an actual file path to OCR, or None if unreachable.
    Supports absolute paths, relative-to-source-file paths, and common URL
    schemes are skipped (they'd need a downloader)."""
    if ref.startswith(("http://", "https://", "attachment:")):
        return None  # remote or attachment: — skip for MVP
    p = Path(ref)
    if p.is_absolute() and p.exists():
        return p
    sibling = Path(source_file).parent / ref
    if sibling.exists():
        return sibling
    return None


def process_pending_ocr(limit: int = 20) -> dict:
    """Process up to `limit` pending OCR records. Returns stats."""
    if not shutil.which("tesseract"):
        return {"processed": 0, "failed": 0, "error": "tesseract not installed"}

    with connect() as conn:
        rows = conn.execute(
            "SELECT id, source_file, line_no, image_ref FROM ocr_pending "
            "WHERE status = 'pending' LIMIT ?",
            (limit,),
        ).fetchall()
    if not rows:
        return {"processed": 0, "failed": 0}

    processed = 0
    failed = 0
    for r in rows:
        path = _resolve_image_path(r["source_file"], r["image_ref"])
        if path is None:
            with connect() as conn:
                conn.execute(
                    "UPDATE ocr_pending SET status='unreachable', "
                    "processed_at=CURRENT_TIMESTAMP WHERE id=?",
                    (r["id"],),
                )
                conn.commit()
            failed += 1
            continue
        try:
            result = subprocess.run(
                ["tesseract", str(path), "-", "-l", "chi_sim+eng"],
                capture_output=True, text=True, timeout=30,
            )
            text = (result.stdout or "").strip()
            with connect() as conn:
                conn.execute(
                    "UPDATE ocr_pending SET extracted_text=?, status='done', "
                    "processed_at=CURRENT_TIMESTAMP WHERE id=?",
                    (text, r["id"]),
                )
                conn.commit()
            processed += 1
        except Exception as e:
            with connect() as conn:
                conn.execute(
                    "UPDATE ocr_pending SET status=?, processed_at=CURRENT_TIMESTAMP "
                    "WHERE id=?",
                    (f"error:{str(e)[:120]}", r["id"]),
                )
                conn.commit()
            failed += 1
    return {"processed": processed, "failed": failed}
