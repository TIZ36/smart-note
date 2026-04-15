"""PDF → Markdown conversion with fallback chain.

1. MarkItDown (best for structured PDFs with text layers)
2. pdfplumber (fallback for CJK/embedded-font PDFs)
3. OCR via tesseract + pdf2image (fallback for scanned/image-only PDFs)

Saves the .md alongside the original and returns the path.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path


def _progress(step: str, current: int, total: int, detail: str):
    msg = {"step": step, "current": current, "total": total, "detail": detail}
    print(json.dumps(msg, ensure_ascii=False), file=sys.stderr, flush=True)


def _try_markitdown(pdf_path: str) -> str:
    """Attempt conversion with MarkItDown. Returns text or empty string."""
    try:
        from markitdown import MarkItDown
        md = MarkItDown(enable_plugins=False)
        result = md.convert(pdf_path)
        return (result.text_content or "").strip()
    except Exception:
        return ""


def _try_pdfplumber(pdf_path: str) -> str:
    """Fallback: extract text page-by-page with pdfplumber, format as markdown."""
    try:
        import pdfplumber
    except ImportError:
        return ""

    pages_text: list[str] = []
    with pdfplumber.open(pdf_path) as pdf:
        total = len(pdf.pages)
        for i, page in enumerate(pdf.pages):
            text = page.extract_text() or ""
            if text.strip():
                pages_text.append(f"<!-- page {i + 1} -->\n\n{text.strip()}")
            if (i + 1) % 20 == 0:
                _progress("parse", i + 1, total, f"Extracting page {i + 1}/{total}")

    if not pages_text:
        return ""

    full = "\n\n---\n\n".join(pages_text)
    return _format_headings(full)


def _try_ocr(pdf_path: str) -> str:
    """OCR fallback: render PDF pages to images, then run tesseract.
    Requires: tesseract, pdf2image (poppler)."""
    try:
        import pytesseract
        from pdf2image import convert_from_path
    except ImportError:
        return ""

    # Check tesseract is available
    if not shutil.which("tesseract"):
        return ""

    # Use configured or auto-detected OCR languages
    from app.config import settings as _cfg
    ocr_lang = _cfg.ocr_langs if _cfg.ocr_langs else _detect_ocr_lang(pdf_path)
    _progress("parse", 0, 1, f"OCR with tesseract ({ocr_lang}): {Path(pdf_path).name}")

    # Convert pages to images (150 DPI balances speed vs accuracy)
    try:
        images = convert_from_path(pdf_path, dpi=150, fmt="png")
    except Exception as e:
        _progress("parse", 0, 1, f"pdf2image failed: {e}")
        return ""

    total = len(images)
    pages_text: list[str] = []

    for i, img in enumerate(images):
        try:
            text = pytesseract.image_to_string(img, lang=ocr_lang)
        except Exception:
            text = ""
        if text.strip():
            pages_text.append(f"<!-- page {i + 1} -->\n\n{text.strip()}")
        if (i + 1) % 10 == 0 or i + 1 == total:
            _progress("parse", i + 1, total, f"OCR page {i + 1}/{total}")

    if not pages_text:
        return ""

    full = "\n\n---\n\n".join(pages_text)
    return _format_headings(full)


def _detect_ocr_lang(pdf_path: str) -> str:
    """Detect best OCR language based on installed tesseract langs.
    Prefers chi_sim+eng for Chinese PDFs, falls back to eng."""
    available = get_installed_ocr_langs()
    # If Chinese is available and the filename has CJK characters, use it
    has_cjk = any("\u4e00" <= c <= "\u9fff" for c in Path(pdf_path).name)
    if has_cjk and "chi_sim" in available:
        return "chi_sim+eng"
    if "chi_sim" in available:
        return "chi_sim+eng"
    return "eng"


def get_installed_ocr_langs() -> list[str]:
    """Return list of installed tesseract language codes."""
    if not shutil.which("tesseract"):
        return []
    try:
        result = subprocess.run(
            ["tesseract", "--list-langs"],
            capture_output=True, text=True, timeout=5,
        )
        lines = result.stdout.strip().split("\n")
        # First line is header, rest are language codes
        return [l.strip() for l in lines[1:] if l.strip()]
    except Exception:
        return []


def install_ocr_lang(lang: str) -> dict:
    """Install a tesseract language pack via brew.
    Returns {"ok": bool, "message": str}."""
    if not shutil.which("brew"):
        return {"ok": False, "message": "Homebrew not found. Install tesseract-lang manually."}

    # tesseract-lang includes all languages
    try:
        result = subprocess.run(
            ["brew", "install", "tesseract-lang"],
            capture_output=True, text=True, timeout=300,
        )
        if result.returncode == 0:
            return {"ok": True, "message": f"Language packs installed. {lang} should now be available."}
        return {"ok": False, "message": result.stderr.strip() or "brew install failed"}
    except subprocess.TimeoutExpired:
        return {"ok": False, "message": "Installation timed out."}
    except Exception as e:
        return {"ok": False, "message": str(e)}


def _format_headings(text: str) -> str:
    """Light markdown formatting: detect likely chapter/section headings."""
    lines = text.split("\n")
    formatted: list[str] = []
    for line in lines:
        stripped = line.strip()
        if (stripped
            and len(stripped) < 80
            and not stripped.endswith("。")
            and not stripped.endswith(".")
            and re.match(r'^(?:第.{1,4}[章节篇]|Chapter\s+\d|Part\s+\d|\d+[.\s])', stripped, re.IGNORECASE)):
            formatted.append(f"\n## {stripped}\n")
        else:
            formatted.append(line)
    return "\n".join(formatted).strip()


def convert_pdf_to_md(pdf_path: str, output_path: str | None = None) -> str:
    """Convert a PDF file to markdown.

    Fallback chain:
    1. MarkItDown — best for native-text PDFs with structure
    2. pdfplumber — CJK/embedded-font PDFs
    3. OCR (tesseract) — scanned/image-only PDFs

    Args:
        pdf_path: path to the PDF file
        output_path: optional explicit output path

    Returns:
        path to the generated .md file
    """
    pdf = Path(pdf_path)
    if not pdf.exists():
        raise FileNotFoundError(f"PDF not found: {pdf_path}")

    md_path = Path(output_path) if output_path else pdf.with_suffix(".md")

    _progress("parse", 0, 1, f"Converting PDF: {pdf.name}")

    # Try MarkItDown first
    text = _try_markitdown(str(pdf))
    method = "markitdown"

    # Fallback to pdfplumber if empty or too short
    if len(text) < 100:
        _progress("parse", 0, 1, f"MarkItDown insufficient, trying pdfplumber...")
        fallback = _try_pdfplumber(str(pdf))
        if len(fallback) > len(text):
            text = fallback
            method = "pdfplumber"

    # Fallback to OCR if still empty
    if len(text) < 100:
        _progress("parse", 0, 1, f"Text extraction failed, trying OCR...")
        fallback = _try_ocr(str(pdf))
        if len(fallback) > len(text):
            text = fallback
            method = "ocr"

    if not text.strip():
        raise ValueError(
            f"Could not extract text from: {pdf.name}. "
            "No text layer found and OCR produced no output. "
            "Check that tesseract is installed with the required language packs."
        )

    md_path.write_text(text, encoding="utf-8")
    _progress("parse", 1, 1, f"Converted via {method}: {md_path.name} ({len(text)} chars)")

    return str(md_path)
