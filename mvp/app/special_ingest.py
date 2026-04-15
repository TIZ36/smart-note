"""Special Knowledge Ingest — folder → specialknowledge tag → single topic.

Reads all supported files from a folder, chunks them, and ingests
as a single topic under the "specialknowledge" tag. Appends to the
active build (incremental, not a new build).

Use case: user references a paper/codebase/doc set in their notes,
and wants the AI to have access to that material for answering.
"""

from __future__ import annotations

import ast
import json
import logging
import os
import re
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from app.builds import get_active_build_id, create_build
from app.config import settings
from app.db import connect
from app.embed import embed_texts
from app.tokenizer import segment, _split_identifier

logger = logging.getLogger(__name__)

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

CODE_EXTENSIONS = {
    ".py", ".js", ".ts", ".jsx", ".tsx", ".go", ".rs", ".java",
    ".c", ".cpp", ".h", ".sh", ".bash", ".zsh", ".sql",
}

PROSE_EXTENSIONS = {".md", ".txt", ".rst", ".org"}

DOC_EXTENSIONS = {".md", ".txt", ".rst", ".org", ".html", ".xml"}
CONFIG_EXTENSIONS = {".json", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf"}

# Wiki topic categories
CATEGORY_RESEARCH = "research"
CATEGORY_CODEBASE = "codebase"
CATEGORY_DOCS = "docs"
CATEGORY_REFERENCE = "reference"


def detect_wiki_category(
    files: list[Path] | None = None,
    is_pdf: bool = False,
    is_paper: bool = False,
) -> str:
    """Auto-detect wiki topic category from file composition."""
    if is_pdf and is_paper:
        return CATEGORY_RESEARCH
    if is_pdf:
        return CATEGORY_DOCS

    if not files:
        return CATEGORY_REFERENCE

    exts = [f.suffix.lower() for f in files if f.suffix]
    total = len(exts)
    if total == 0:
        return CATEGORY_REFERENCE

    code_count = sum(1 for e in exts if e in CODE_EXTENSIONS)
    doc_count = sum(1 for e in exts if e in DOC_EXTENSIONS)
    config_count = sum(1 for e in exts if e in CONFIG_EXTENSIONS)

    code_ratio = code_count / total
    doc_ratio = doc_count / total

    if code_ratio > 0.4:
        return CATEGORY_CODEBASE
    if doc_ratio > 0.5:
        return CATEGORY_DOCS
    if config_count > 0 and code_count > 0:
        return CATEGORY_CODEBASE
    return CATEGORY_REFERENCE


# Chunk size limits
CODE_MAX_CHUNK = 1200
PROSE_MAX_CHUNK = 1000
FALLBACK_MAX_CHUNK = 800

# AI enrichment
AI_BATCH_SIZE = 5
MAX_AI_CONCURRENCY = int(os.environ.get("INGEST_CONCURRENCY", "10"))

# ── Structural keyword regex ──

_HEADING_RE = re.compile(r'^#{1,4}\s+(.+)', re.MULTILINE)
# Python
_PY_DEF_RE = re.compile(r'^(?:def|class)\s+(\w+)', re.MULTILINE)
_PY_IMPORT_RE = re.compile(r'^(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))', re.MULTILINE)
_PY_DOCSTRING_RE = re.compile(r'"""(.+?)"""', re.DOTALL)
# JS/TS
_JS_FUNC_RE = re.compile(r'(?:function|class)\s+(\w+)', re.MULTILINE)
_EXPORT_RE = re.compile(r'export\s+(?:default\s+)?(?:function|class|const|let|type|interface)\s+(\w+)', re.MULTILINE)
_JS_IMPORT_RE = re.compile(r'(?:import\s+.*?from\s+["\']([^"\']+)|require\(["\']([^"\']+))', re.MULTILINE)
# Go
_GO_FUNC_RE = re.compile(r'^func\s+(?:\([^)]+\)\s+)?(\w+)', re.MULTILINE)
_GO_TYPE_RE = re.compile(r'^type\s+(\w+)', re.MULTILINE)
# Rust
_RS_FN_RE = re.compile(r'^(?:pub\s+)?fn\s+(\w+)', re.MULTILINE)
_RS_STRUCT_RE = re.compile(r'^(?:pub\s+)?(?:struct|enum|trait)\s+(\w+)', re.MULTILINE)
_RS_IMPL_RE = re.compile(r'^impl(?:<[^>]+>)?\s+(\w+)', re.MULTILINE)
_RS_USE_RE = re.compile(r'^use\s+([\w:]+)', re.MULTILINE)
# JSDoc
_JSDOC_RE = re.compile(r'/\*\*\s*\n?\s*\*?\s*(.+?)(?:\n|\*/)', re.MULTILINE)

# ── Code boundary regex for chunking ──

_PY_BOUNDARY_RE = re.compile(r'^(?:def |class |@)', re.MULTILINE)
_JS_BOUNDARY_RE = re.compile(r'^(?:function |class |export |const |let |var )', re.MULTILINE)
_GO_BOUNDARY_RE = re.compile(r'^(?:func |type |var |const )', re.MULTILINE)
_RS_BOUNDARY_RE = re.compile(r'^(?:fn |pub fn |pub\(crate\) fn |impl |struct |enum |trait |mod |use )', re.MULTILINE)
_MD_BOUNDARY_RE = re.compile(r'^#{1,4}\s', re.MULTILINE)

# Table detection
_TABLE_ROW_RE = re.compile(r'^\|.+\|$', re.MULTILINE)
_TABLE_SEP_RE = re.compile(r'^\|[-:\s|]+\|$', re.MULTILINE)

# Cross-document reference patterns
_XREF_RE = re.compile(r'(?:详见|参见|参考|见|see|refer to|cf\.)\s*[《「【]?([^》」】\n]{3,40})[》」】]?', re.IGNORECASE)

# ── Academic paper regex ──

# Common section headings in papers (case-insensitive matching done in code)
_PAPER_SECTIONS = {
    "abstract", "introduction", "background", "related work", "related works",
    "methodology", "methods", "method", "approach", "model", "framework",
    "experiments", "experiment", "experimental setup", "experimental results",
    "results", "evaluation", "discussion", "analysis",
    "conclusion", "conclusions", "future work", "limitations",
    "references", "bibliography", "acknowledgments", "acknowledgements",
    "appendix", "supplementary", "supplementary material",
}

# Citation patterns: [1], [1,2], [Author2023], (Author et al., 2023)
_CITATION_RE = re.compile(r'\[(\d+(?:\s*[,;\s]\s*\d+)*)\]')
_AUTHOR_CITE_RE = re.compile(r'\(([A-Z][a-z]+(?:\s+(?:et\s+al\.?|and|&)\s+[A-Z][a-z]+)?,?\s*\d{4}[a-z]?)\)')

# Academic terms extraction
_TERM_BOLD_RE = re.compile(r'\*\*([^*]+)\*\*')
_TERM_ITALIC_RE = re.compile(r'(?<!\*)\*([^*]+)\*(?!\*)')
_TERM_DEFINE_RE = re.compile(r'(?:we (?:define|propose|introduce|present)|called|known as|referred to as)\s+["\']?(\w[\w\s]{2,30})["\']?', re.IGNORECASE)

PAPER_CHUNK_MAX = 1500  # Papers need larger context per chunk


def _extract_doc_metadata(content: str, source_name: str) -> dict:
    """Extract document-level metadata: title, type, references."""
    meta = {"title": "", "doc_type": "", "references": []}

    # Title = first heading or filename
    heading_match = _HEADING_RE.search(content[:2000])
    if heading_match:
        meta["title"] = heading_match.group(1).strip()
    else:
        meta["title"] = source_name.rsplit("/", 1)[-1].rsplit(".", 1)[0]

    # Detect doc type from title/content keywords
    title_lower = meta["title"].lower()
    content_lower = content[:3000].lower()
    for keyword, dtype in [
        ("需求", "requirement"), ("prd", "requirement"), ("requirement", "requirement"),
        ("技术方案", "technical"), ("架构", "technical"), ("设计", "technical"), ("design", "technical"),
        ("测试", "testing"), ("test", "testing"), ("qa", "testing"),
        ("上线", "deployment"), ("发布", "deployment"), ("deploy", "deployment"), ("release", "deployment"),
        ("产品", "product"), ("product", "product"),
        ("会议", "meeting"), ("meeting", "meeting"),
        ("api", "api"), ("接口", "api"),
    ]:
        if keyword in title_lower or keyword in content_lower:
            meta["doc_type"] = dtype
            break

    # Cross-document references
    for m in _XREF_RE.finditer(content):
        ref = m.group(1).strip()
        if ref and len(ref) > 3:
            meta["references"].append(ref)

    return meta


def _extract_structural_keywords(content: str, ext: str) -> list[str]:
    """Extract keywords from document structure — headings, function/class names,
    imports, docstrings. Zero LLM tokens: purely regex-based."""
    kws: list[str] = []

    # Markdown headings
    if ext in PROSE_EXTENSIONS:
        kws.extend(m.group(1).strip() for m in _HEADING_RE.finditer(content))

    # Python
    if ext == ".py":
        kws.extend(m.group(1) for m in _PY_DEF_RE.finditer(content)
                    if not m.group(1).startswith("_"))
        for m in _PY_IMPORT_RE.finditer(content):
            mod = m.group(1) or m.group(2)
            if mod:
                kws.append(mod.split(".")[-1])
        # First line of docstrings
        for m in _PY_DOCSTRING_RE.finditer(content):
            first_line = m.group(1).strip().split("\n")[0].strip()
            if first_line and len(first_line) < 120:
                kws.append(first_line)

    # JS/TS
    if ext in (".js", ".ts", ".jsx", ".tsx"):
        kws.extend(m.group(1) for m in _JS_FUNC_RE.finditer(content))
        kws.extend(m.group(1) for m in _EXPORT_RE.finditer(content))
        for m in _JS_IMPORT_RE.finditer(content):
            mod = m.group(1) or m.group(2)
            if mod:
                kws.append(mod.split("/")[-1])
        for m in _JSDOC_RE.finditer(content):
            first_line = m.group(1).strip()
            if first_line and len(first_line) < 120:
                kws.append(first_line)

    # Go
    if ext == ".go":
        kws.extend(m.group(1) for m in _GO_FUNC_RE.finditer(content))
        kws.extend(m.group(1) for m in _GO_TYPE_RE.finditer(content))

    # Rust
    if ext == ".rs":
        kws.extend(m.group(1) for m in _RS_FN_RE.finditer(content))
        kws.extend(m.group(1) for m in _RS_STRUCT_RE.finditer(content))
        kws.extend(m.group(1) for m in _RS_IMPL_RE.finditer(content))
        for m in _RS_USE_RE.finditer(content):
            kws.append(m.group(1).split("::")[-1])

    # Deduplicate, preserve order, expand identifiers
    seen: set[str] = set()
    unique: list[str] = []
    for k in kws:
        kl = k.lower()
        if kl not in seen and len(k) > 1:
            seen.add(kl)
            unique.append(k)
            # Also add split identifier parts
            for part in _split_identifier(k):
                if part not in seen:
                    seen.add(part)
                    unique.append(part)
    return unique


def _progress(step: str, current: int, total: int, detail: str):
    msg = {"step": step, "current": current, "total": total, "detail": detail}
    print(json.dumps(msg, ensure_ascii=False), file=sys.stderr, flush=True)


def _read_file_safe(path: Path) -> str:
    """Read a file, skip binary/unreadable files."""
    try:
        content = path.read_text(encoding="utf-8", errors="ignore")
        if "\x00" in content[:1000]:
            return ""
        return content
    except Exception:
        return ""


# ── Chunking ──

def _get_boundary_re(ext: str) -> re.Pattern | None:
    """Return the boundary regex for the given file extension."""
    if ext == ".py":
        return _PY_BOUNDARY_RE
    if ext in (".js", ".ts", ".jsx", ".tsx"):
        return _JS_BOUNDARY_RE
    if ext == ".go":
        return _GO_BOUNDARY_RE
    if ext == ".rs":
        return _RS_BOUNDARY_RE
    if ext in PROSE_EXTENSIONS:
        return _MD_BOUNDARY_RE
    return None


def _chunk_by_boundaries(text: str, source_name: str, boundary_re: re.Pattern, max_len: int) -> list[dict]:
    """Split text at top-level definition boundaries, respecting max chunk size."""
    lines = text.splitlines()
    if not lines:
        return []

    # Find boundary line indices (0-based)
    boundaries = []
    for i, line in enumerate(lines):
        if boundary_re.match(line):
            boundaries.append(i)

    if not boundaries:
        # No boundaries found — fall back to size-based chunking
        return _chunk_lines(text, source_name, max_len)

    # Ensure we start from line 0
    if boundaries[0] != 0:
        boundaries.insert(0, 0)

    chunks = []
    for bi, start in enumerate(boundaries):
        end = boundaries[bi + 1] if bi + 1 < len(boundaries) else len(lines)
        block = "\n".join(lines[start:end]).strip()
        if not block:
            continue

        if len(block) <= max_len:
            chunks.append({
                "text": block,
                "source_ref": f"{source_name}:line:{start + 1}-{end}",
                "line_start": start + 1,
                "line_end": end,
            })
        else:
            # Block too large — split at blank lines, keeping signature attached
            signature = lines[start] if start < len(lines) else ""
            sub_chunks = _split_large_block(lines[start:end], source_name, start + 1, signature, max_len)
            chunks.extend(sub_chunks)

    return chunks


def _chunk_python_ast(text: str, source_name: str, max_len: int) -> list[dict] | None:
    """Try AST-based chunking for Python. Returns None on parse failure."""
    try:
        tree = ast.parse(text)
    except SyntaxError:
        return None

    lines = text.splitlines()
    if not lines:
        return None

    chunks = []
    # Collect top-level nodes with line info
    nodes = [(n.lineno, n.end_lineno) for n in ast.iter_child_nodes(tree)
             if hasattr(n, "lineno") and hasattr(n, "end_lineno")]

    if not nodes:
        return None

    # Sort by start line
    nodes.sort()

    # Include any preamble (imports, module docstring) before first node
    if nodes[0][0] > 1:
        preamble = "\n".join(lines[:nodes[0][0] - 1]).strip()
        if preamble:
            chunks.append({
                "text": preamble,
                "source_ref": f"{source_name}:line:1-{nodes[0][0] - 1}",
                "line_start": 1,
                "line_end": nodes[0][0] - 1,
            })

    for start_line, end_line in nodes:
        block = "\n".join(lines[start_line - 1:end_line]).strip()
        if not block:
            continue
        if len(block) <= max_len:
            chunks.append({
                "text": block,
                "source_ref": f"{source_name}:line:{start_line}-{end_line}",
                "line_start": start_line,
                "line_end": end_line,
            })
        else:
            signature = lines[start_line - 1] if start_line - 1 < len(lines) else ""
            sub_chunks = _split_large_block(
                lines[start_line - 1:end_line], source_name, start_line, signature, max_len
            )
            chunks.extend(sub_chunks)

    return chunks if chunks else None


def _split_large_block(block_lines: list[str], source_name: str, start_line: int,
                       signature: str, max_len: int) -> list[dict]:
    """Split a large code block at blank lines, attaching signature to first sub-chunk."""
    chunks = []
    buf = []
    buf_len = 0
    chunk_start = start_line

    for i, line in enumerate(block_lines):
        buf.append(line)
        buf_len += len(line) + 1

        # Split at blank lines when we exceed the limit
        is_blank = not line.strip()
        if buf_len >= max_len and is_blank and len(buf) > 1:
            content = "\n".join(buf).strip()
            if content:
                # Prepend signature context to non-first chunks
                if chunks and signature:
                    content = f"# [{signature.strip()}] continued\n{content}"
                chunks.append({
                    "text": content,
                    "source_ref": f"{source_name}:line:{chunk_start}-{start_line + i}",
                    "line_start": chunk_start,
                    "line_end": start_line + i,
                })
            buf = []
            buf_len = 0
            chunk_start = start_line + i + 1

    # Remaining
    if buf:
        content = "\n".join(buf).strip()
        if content:
            if chunks and signature:
                content = f"# [{signature.strip()}] continued\n{content}"
            chunks.append({
                "text": content,
                "source_ref": f"{source_name}:line:{chunk_start}-{start_line + len(block_lines) - 1}",
                "line_start": chunk_start,
                "line_end": start_line + len(block_lines) - 1,
            })

    return chunks


def _chunk_lines(text: str, source_name: str, max_len: int) -> list[dict]:
    """Fallback: split text into chunks by line count/size."""
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


def _chunk_file(text: str, source_name: str, ext: str) -> list[dict]:
    """Dispatch to the best chunking strategy for this file type."""
    ext = ext.lower()

    # Python: try AST first, fall back to regex boundaries
    if ext == ".py":
        ast_chunks = _chunk_python_ast(text, source_name, CODE_MAX_CHUNK)
        if ast_chunks:
            return ast_chunks
        # AST failed — use regex boundaries
        return _chunk_by_boundaries(text, source_name, _PY_BOUNDARY_RE, CODE_MAX_CHUNK)

    # Code files with boundary regex
    if ext in CODE_EXTENSIONS:
        boundary_re = _get_boundary_re(ext)
        if boundary_re:
            return _chunk_by_boundaries(text, source_name, boundary_re, CODE_MAX_CHUNK)
        return _chunk_lines(text, source_name, FALLBACK_MAX_CHUNK)

    # Prose files (markdown, etc.) — table-aware chunking with context prefix
    if ext in PROSE_EXTENSIONS:
        return _chunk_prose(text, source_name, PROSE_MAX_CHUNK)

    # Fallback
    return _chunk_lines(text, source_name, FALLBACK_MAX_CHUNK)


def _chunk_prose(text: str, source_name: str, max_len: int) -> list[dict]:
    """Smart prose chunking: keeps tables intact, adds heading context prefix."""
    lines = text.splitlines()
    if not lines:
        return []

    chunks = []
    current_heading = ""
    buf: list[str] = []
    buf_start = 1
    in_table = False
    table_buf: list[str] = []
    table_start = 0

    def _flush_buf():
        nonlocal buf, buf_start
        if not buf:
            return
        content = "\n".join(buf).strip()
        if content:
            # Prepend heading context if this chunk doesn't start with a heading
            if current_heading and not content.startswith("#"):
                content = f"[{current_heading}]\n{content}"
            chunks.append({
                "text": content,
                "source_ref": f"{source_name}:line:{buf_start}-{buf_start + len(buf) - 1}",
                "line_start": buf_start,
                "line_end": buf_start + len(buf) - 1,
            })
        buf = []

    def _flush_table():
        nonlocal table_buf, in_table
        if not table_buf:
            return
        content = "\n".join(table_buf).strip()
        if content:
            # Table always gets heading context
            if current_heading:
                content = f"[{current_heading}]\n{content}"
            chunks.append({
                "text": content,
                "source_ref": f"{source_name}:line:{table_start}-{table_start + len(table_buf) - 1}",
                "line_start": table_start,
                "line_end": table_start + len(table_buf) - 1,
            })
        table_buf = []
        in_table = False

    for i, line in enumerate(lines):
        line_no = i + 1

        # Detect table rows
        is_table_row = bool(_TABLE_ROW_RE.match(line)) or bool(_TABLE_SEP_RE.match(line))

        if is_table_row:
            if not in_table:
                # Starting a table — flush the text buffer first
                _flush_buf()
                in_table = True
                table_start = line_no
                table_buf = []
            table_buf.append(line)
            continue

        if in_table:
            # Exiting a table — flush it as a single chunk
            _flush_table()

        # Heading boundary — flush and start new section
        if _MD_BOUNDARY_RE.match(line):
            _flush_buf()
            heading_text = line.lstrip("#").strip()
            current_heading = heading_text
            buf = [line]
            buf_start = line_no
            continue

        # Normal line — accumulate
        if not buf:
            buf_start = line_no
        buf.append(line)

        # Check size limit
        buf_len = sum(len(l) + 1 for l in buf)
        if buf_len >= max_len:
            _flush_buf()
            buf_start = line_no + 1

    # Flush remaining
    if in_table:
        _flush_table()
    _flush_buf()

    return chunks


def _is_academic_paper(text: str) -> bool:
    """Heuristic: detect if a markdown file looks like an academic paper."""
    text_lower = text[:5000].lower()
    signals = 0
    # Check for common paper section headings
    for sec in ("abstract", "introduction", "conclusion", "references", "related work"):
        if sec in text_lower:
            signals += 1
    # Check for citations
    if _CITATION_RE.search(text) or _AUTHOR_CITE_RE.search(text):
        signals += 1
    return signals >= 3


def _chunk_academic_paper(text: str, source_name: str) -> list[dict]:
    """Chunk an academic paper by section headings, keeping each section intact
    when possible. Falls back to splitting large sections at paragraph boundaries."""
    lines = text.splitlines()
    if not lines:
        return []

    # Find section boundaries (markdown headings)
    sections: list[tuple[int, str]] = []  # (line_idx, heading_text)
    for i, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith("#"):
            heading = stripped.lstrip("#").strip()
            sections.append((i, heading))

    if not sections:
        return _chunk_lines(text, source_name, PAPER_CHUNK_MAX)

    # Ensure start from line 0
    if sections[0][0] != 0:
        sections.insert(0, (0, "preamble"))

    chunks = []
    for si, (start, heading) in enumerate(sections):
        end = sections[si + 1][0] if si + 1 < len(sections) else len(lines)
        block = "\n".join(lines[start:end]).strip()
        if not block:
            continue

        if len(block) <= PAPER_CHUNK_MAX:
            chunks.append({
                "text": block,
                "source_ref": f"{source_name}:line:{start + 1}-{end}",
                "line_start": start + 1,
                "line_end": end,
                "section": heading,
            })
        else:
            # Split large section at paragraph boundaries (blank lines)
            para_chunks = _split_section_at_paragraphs(
                lines[start:end], source_name, start + 1, heading, PAPER_CHUNK_MAX
            )
            chunks.extend(para_chunks)

    return chunks


def _split_section_at_paragraphs(block_lines: list[str], source_name: str,
                                  start_line: int, section: str, max_len: int) -> list[dict]:
    """Split a paper section at paragraph boundaries (blank lines)."""
    chunks = []
    buf: list[str] = []
    buf_len = 0
    chunk_start = start_line
    chunk_idx = 0

    for i, line in enumerate(block_lines):
        buf.append(line)
        buf_len += len(line) + 1

        is_blank = not line.strip()
        if buf_len >= max_len and is_blank and len(buf) > 1:
            content = "\n".join(buf).strip()
            if content:
                # Add section context to continuation chunks
                if chunk_idx > 0:
                    content = f"[Section: {section}]\n\n{content}"
                chunks.append({
                    "text": content,
                    "source_ref": f"{source_name}:line:{chunk_start}-{start_line + i}",
                    "line_start": chunk_start,
                    "line_end": start_line + i,
                    "section": section,
                })
                chunk_idx += 1
            buf = []
            buf_len = 0
            chunk_start = start_line + i + 1

    if buf:
        content = "\n".join(buf).strip()
        if content:
            if chunk_idx > 0:
                content = f"[Section: {section}]\n\n{content}"
            chunks.append({
                "text": content,
                "source_ref": f"{source_name}:line:{chunk_start}-{start_line + len(block_lines) - 1}",
                "line_start": chunk_start,
                "line_end": start_line + len(block_lines) - 1,
                "section": section,
            })

    return chunks


def _extract_academic_keywords(text: str) -> list[str]:
    """Extract academic-specific keywords from a paper's markdown."""
    kws: list[str] = []

    # Section headings
    for m in _HEADING_RE.finditer(text):
        kws.append(m.group(1).strip())

    # Bold terms (often key concepts)
    for m in _TERM_BOLD_RE.finditer(text):
        term = m.group(1).strip()
        if 2 < len(term) < 60:
            kws.append(term)

    # Defined/proposed terms
    for m in _TERM_DEFINE_RE.finditer(text):
        term = m.group(1).strip()
        if 2 < len(term) < 40:
            kws.append(term)

    # Author citations as entities
    for m in _AUTHOR_CITE_RE.finditer(text):
        kws.append(m.group(1))

    # Deduplicate
    seen: set[str] = set()
    unique: list[str] = []
    for k in kws:
        kl = k.lower()
        if kl not in seen and len(k) > 1:
            seen.add(kl)
            unique.append(k)
    return unique


# ── AI Enrichment ──

def _build_wiki_enrich_prompt() -> str:
    return """You are a code/document analyst. For each chunk, provide a brief analysis.

OUTPUT FORMAT — JSON array (one object per chunk, same order as input):
[
  {
    "summary": "1-2 sentence description of what this code/text does",
    "keywords": ["semantic", "keywords", "describing", "purpose"],
    "entities": ["library_names", "api_names", "services"]
  }
]

RULES:
- summary: describe WHAT the code does functionally, not its syntax
- keywords: include purpose, patterns, algorithms, domain terms
- entities: libraries, APIs, frameworks, services, data structures
- Reply with ONLY the JSON array"""


def _ai_enrich_batch(chunks: list[dict]) -> list[dict]:
    """Call LLM to enrich a batch of chunks with summaries and keywords."""
    from app.ai_enrich import _call_llm

    system = _build_wiki_enrich_prompt()
    user_parts = []
    for i, c in enumerate(chunks):
        text = c["text"][:2000]  # Truncate very long chunks for the prompt
        user_parts.append(f"--- Chunk {i + 1} ---\n{text}")
    user_msg = "\n\n".join(user_parts)

    raw = _call_llm(system, user_msg)
    if not raw:
        return [{"summary": "", "keywords": [], "entities": []} for _ in chunks]

    try:
        cleaned = raw.strip()
        if cleaned.startswith("```"):
            cleaned = cleaned.split("\n", 1)[1] if "\n" in cleaned else cleaned
            if cleaned.endswith("```"):
                cleaned = cleaned[:-3]
            cleaned = cleaned.strip()

        parsed = json.loads(cleaned)
        if not isinstance(parsed, list):
            parsed = [parsed]

        results = []
        for i in range(len(chunks)):
            if i < len(parsed):
                item = parsed[i]
                results.append({
                    "summary": item.get("summary", ""),
                    "keywords": item.get("keywords", []),
                    "entities": item.get("entities", []),
                })
            else:
                results.append({"summary": "", "keywords": [], "entities": []})
        return results
    except (json.JSONDecodeError, TypeError):
        logger.warning("Failed to parse wiki AI enrichment response")
        return [{"summary": "", "keywords": [], "entities": []} for _ in chunks]


def _ai_enrich_all(all_chunks: list[dict], on_progress=None) -> list[dict]:
    """Enrich all chunks with AI summaries/keywords using concurrent API calls."""
    if not getattr(settings, "ingest_ai_enabled", False):
        return [{"summary": "", "keywords": [], "entities": []} for _ in all_chunks]

    total = len(all_chunks)
    results = [None] * total

    # Build batches
    batches = []
    for i in range(0, total, AI_BATCH_SIZE):
        batch_chunks = all_chunks[i:i + AI_BATCH_SIZE]
        batches.append((i, batch_chunks))

    done_count = 0

    with ThreadPoolExecutor(max_workers=min(MAX_AI_CONCURRENCY, len(batches))) as executor:
        futures = {
            executor.submit(_ai_enrich_batch, batch_chunks): start_idx
            for start_idx, batch_chunks in batches
        }
        for future in as_completed(futures):
            start_idx = futures[future]
            try:
                batch_results = future.result()
            except Exception:
                batch_results = [{"summary": "", "keywords": [], "entities": []}
                                 for _ in range(min(AI_BATCH_SIZE, total - start_idx))]
            for j, r in enumerate(batch_results):
                if start_idx + j < total:
                    results[start_idx + j] = r
            done_count += 1
            if on_progress:
                on_progress(min(done_count * AI_BATCH_SIZE, total), total)

    # Fill any None gaps
    return [r or {"summary": "", "keywords": [], "entities": []} for r in results]


def _generate_topic_summary(ai_enrichments: list[dict], structural_kws: list[str],
                            topic_name: str, file_count: int) -> str:
    """Generate a semantic summary for the entire wiki topic."""
    if getattr(settings, "ingest_ai_enabled", False):
        from app.ai_enrich import _call_llm
        # Collect first N chunk summaries
        summaries = [e["summary"] for e in ai_enrichments if e.get("summary")][:20]
        if summaries:
            system = "Summarize this codebase/document collection in 2-3 sentences. Focus on what it does, key technologies, and main abstractions. Reply with ONLY the summary text."
            user = f"Topic: {topic_name}\n\nChunk summaries:\n" + "\n".join(f"- {s}" for s in summaries)
            result = _call_llm(system, user)
            if result:
                return result.strip()

    # Fallback: structural keywords + file stats
    kw_preview = ", ".join(structural_kws[:15]) if structural_kws else "no keywords"
    return f"{topic_name}: {kw_preview} ({file_count} files)"


# ── Main ingestion ──

def ingest_folder(folder_path: str, topic_name: str | None = None) -> dict:
    """Ingest all supported files in a folder as a single specialknowledge topic."""
    folder = Path(folder_path)
    if not folder.is_dir():
        raise FileNotFoundError(f"Folder not found: {folder_path}")

    if not topic_name:
        topic_name = folder.name

    _progress("parse", 0, 0, f"Scanning folder: {folder.name}")

    # Collect all supported files recursively
    files: list[Path] = []
    for ext in TEXT_EXTENSIONS:
        files.extend(folder.rglob(f"*{ext}"))
    for f in folder.rglob("*"):
        if f.is_file() and f.suffix == "" and f.name not in {".", ".."} and not f.name.startswith("."):
            files.append(f)

    # Auto-convert PDFs to markdown
    pdf_files = sorted(folder.rglob("*.pdf"))
    converted_count = 0
    has_paper = False
    converted_from_pdf: set[Path] = set()  # track which .md files came from PDFs
    if pdf_files:
        from app.pdf_convert import convert_pdf_to_md
        for pf in pdf_files:
            md_target = pf.with_suffix(".md")
            if md_target in files:
                continue  # already have a .md with same name
            _progress("parse", 0, len(pdf_files), f"Converting PDF: {pf.name}")
            try:
                md_path = convert_pdf_to_md(str(pf), str(md_target))
                md_file = Path(md_path)
                files.append(md_file)
                converted_from_pdf.add(md_file)
                converted_count += 1
                # Check if any converted PDF is a paper
                md_text = md_file.read_text(encoding="utf-8", errors="ignore")[:5000]
                if _is_academic_paper(md_text):
                    has_paper = True
            except Exception as e:
                _progress("parse", 0, 0, f"PDF convert failed: {pf.name} — {e}")

    files = sorted(set(files))
    category = detect_wiki_category(files=files, is_pdf=converted_count > 0, is_paper=has_paper)
    file_label = f"{len(files)} files"
    if converted_count:
        file_label += f" ({converted_count} PDF converted)"
    _progress("parse", 0, len(files), f"Found {file_label} [{category}]")

    if not files:
        return {"inserted": 0, "files": 0, "message": "No supported files found in folder."}

    # Read, chunk, and extract keywords from all files
    all_chunks: list[dict] = []
    all_structural_kws: list[str] = []
    for i, f in enumerate(files):
        rel = f.relative_to(folder)
        content = _read_file_safe(f)
        if not content.strip():
            continue
        ext = f.suffix.lower()

        # PDF-converted markdown: use academic paper chunking if it's a paper
        if f in converted_from_pdf and _is_academic_paper(content):
            all_structural_kws.extend(_extract_academic_keywords(content))
            file_chunks = _chunk_academic_paper(content, str(rel))
        else:
            all_structural_kws.extend(_extract_structural_keywords(content, ext))
            file_chunks = _chunk_file(content, str(rel), ext)

        # Extract document-level metadata
        doc_meta = _extract_doc_metadata(content, str(rel))
        if doc_meta["title"]:
            all_structural_kws.append(doc_meta["title"])
        if doc_meta["doc_type"]:
            all_structural_kws.append(doc_meta["doc_type"])
        for ref in doc_meta.get("references", []):
            all_structural_kws.append(ref)

        for chunk in file_chunks:
            chunk["source_file"] = str(f)
            chunk["ext"] = ext
            chunk["doc_title"] = doc_meta.get("title", "")
            chunk["doc_type"] = doc_meta.get("doc_type", "")
        all_chunks.extend(file_chunks)
        if (i + 1) % 10 == 0 or i + 1 == len(files):
            _progress("parse", i + 1, len(files), f"{i + 1}/{len(files)} files, {len(all_chunks)} chunks")

    total = len(all_chunks)
    if total == 0:
        return {"inserted": 0, "files": len(files), "message": "Files contained no text content."}

    # Deduplicate structural keywords
    seen_kw: set[str] = set()
    unique_structural: list[str] = []
    for k in all_structural_kws:
        kl = k.lower()
        if kl not in seen_kw:
            seen_kw.add(kl)
            unique_structural.append(k)

    _progress("parse", len(files), len(files), f"{len(files)} files → {total} chunks, {len(unique_structural)} keywords")

    build_id = create_build(f"wiki:{topic_name}")

    # Embed all chunks
    _progress("embed", 0, total, "Generating embeddings...")
    texts = [c["text"] for c in all_chunks]
    vectors = embed_texts(texts)
    _progress("embed", total, total, "Embeddings done")

    # Segment with code-aware or jieba tokenization
    _progress("segment", 0, total, "Segmenting text...")
    segmented = []
    for i, (text, chunk) in enumerate(zip(texts, all_chunks)):
        is_code = chunk.get("ext", "") in CODE_EXTENSIONS
        segmented.append(segment(text, is_code=is_code))
    _progress("segment", total, total, "Segmentation done")

    # AI enrichment (optional, gated by settings)
    ai_enrichments = None
    if getattr(settings, "ingest_ai_enabled", False):
        _progress("ai_enrich", 0, total, "AI enrichment...")
        ai_enrichments = _ai_enrich_all(
            all_chunks,
            on_progress=lambda done, tot: _progress("ai_enrich", done, tot, f"AI enrichment {done}/{tot}")
        )
        _progress("ai_enrich", total, total, "AI enrichment done")

    # Generate topic-level summary
    topic_summary = _generate_topic_summary(
        ai_enrichments or [], unique_structural, topic_name, len(files)
    )

    # Store chunks
    _progress("store", 0, total, "Storing chunks...")
    inserted = 0
    all_keywords_for_topic: list[str] = list(unique_structural)

    with connect() as conn:
        for idx, chunk in enumerate(all_chunks):
            seg_tokens = segmented[idx].split()
            # Merge keywords from multiple sources
            chunk_keywords = set(t for t in seg_tokens if len(t) > 1)

            # Add structural keywords that appear in this chunk
            chunk_text_lower = chunk["text"].lower()
            for kw in unique_structural:
                if kw.lower() in chunk_text_lower:
                    chunk_keywords.update(_split_identifier(kw))

            # Add document-level metadata as keywords
            if chunk.get("doc_title"):
                for word in chunk["doc_title"].split():
                    if len(word) > 1:
                        chunk_keywords.add(word.lower())
            if chunk.get("doc_type"):
                chunk_keywords.add(chunk["doc_type"])

            # Add AI-extracted keywords
            ai_summary = ""
            ai_entities = "[]"
            if ai_enrichments and idx < len(ai_enrichments):
                enrichment = ai_enrichments[idx]
                ai_summary = enrichment.get("summary", "")
                for kw in enrichment.get("keywords", []):
                    chunk_keywords.add(kw.lower())
                    all_keywords_for_topic.append(kw)
                ai_entities = json.dumps(enrichment.get("entities", []), ensure_ascii=False)

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
                    f"wiki:{topic_name}",
                    None,
                    json.dumps(vectors[idx]),
                    json.dumps(sorted(chunk_keywords), ensure_ascii=False),
                    ai_entities,
                    ai_summary,
                ),
            )
            inserted += 1

            if (idx + 1) % 50 == 0 or idx + 1 == total:
                _progress("store", idx + 1, total, f"Stored {idx + 1}/{total}")

        # Deduplicate topic-level keywords
        topic_kws_seen: set[str] = set()
        topic_kws_unique: list[str] = []
        for k in all_keywords_for_topic:
            kl = k.lower()
            if kl not in topic_kws_seen and len(k) > 1:
                topic_kws_seen.add(kl)
                topic_kws_unique.append(k)

        # Create tag_segment with semantic summary
        conn.execute(
            """
            INSERT INTO tag_segments(build_id, source_file, tag, topic_name, line_start, line_end, summary, keywords_json, entities_json, is_credential)
            VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, 0)
            """,
            (
                build_id,
                folder_path,
                f"wiki:{topic_name}",
                topic_name,
                total,
                topic_summary,
                json.dumps(topic_kws_unique[:200], ensure_ascii=False),
                json.dumps({"category": category}),
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


def ingest_pdf(pdf_path: str, topic_name: str | None = None) -> dict:
    """Ingest a PDF file as a wiki topic.

    Converts PDF → markdown via MarkItDown, then ingests the markdown
    with academic paper-aware chunking and keyword extraction.
    Stores the original PDF path for "view original" functionality.

    Returns:
        dict with inserted count, topic, md_path, pdf_path, message
    """
    from app.pdf_convert import convert_pdf_to_md

    pdf = Path(pdf_path)
    if not pdf.exists():
        raise FileNotFoundError(f"PDF not found: {pdf_path}")

    if not topic_name:
        topic_name = pdf.stem

    # Step 1: Convert PDF to markdown
    _progress("parse", 0, 1, f"Converting PDF: {pdf.name}")
    md_path = convert_pdf_to_md(str(pdf))
    md_text = Path(md_path).read_text(encoding="utf-8")
    _progress("parse", 1, 1, f"Converted: {len(md_text)} chars")

    # Step 2: Detect if academic paper and chunk accordingly
    is_paper = _is_academic_paper(md_text)
    category = detect_wiki_category(is_pdf=True, is_paper=is_paper)
    _progress("parse", 1, 1, f"{'Academic paper' if is_paper else 'General document'} detected [{category}]")

    source_name = pdf.name
    if is_paper:
        all_chunks = _chunk_academic_paper(md_text, source_name)
        all_kws = _extract_academic_keywords(md_text)
    else:
        all_chunks = _chunk_by_boundaries(md_text, source_name, _MD_BOUNDARY_RE, PROSE_MAX_CHUNK)
        all_kws = _extract_structural_keywords(md_text, ".md")

    # All chunks point to the converted .md as source_file
    for chunk in all_chunks:
        chunk["source_file"] = md_path
        chunk["ext"] = ".md"

    total = len(all_chunks)
    if total == 0:
        return {"inserted": 0, "files": 1, "message": "PDF produced no text content."}

    # Deduplicate keywords
    seen_kw: set[str] = set()
    unique_kws: list[str] = []
    for k in all_kws:
        kl = k.lower()
        if kl not in seen_kw:
            seen_kw.add(kl)
            unique_kws.append(k)

    _progress("parse", 1, 1, f"{total} chunks, {len(unique_kws)} keywords")

    build_id = create_build(f"wiki:{topic_name}")

    # Embed
    _progress("embed", 0, total, "Generating embeddings...")
    texts = [c["text"] for c in all_chunks]
    vectors = embed_texts(texts)
    _progress("embed", total, total, "Embeddings done")

    # Segment
    _progress("segment", 0, total, "Segmenting text...")
    segmented = [segment(t) for t in texts]
    _progress("segment", total, total, "Segmentation done")

    # AI enrichment (optional)
    ai_enrichments = None
    if getattr(settings, "ingest_ai_enabled", False):
        _progress("ai_enrich", 0, total, "AI enrichment...")
        ai_enrichments = _ai_enrich_all(
            all_chunks,
            on_progress=lambda done, tot: _progress("ai_enrich", done, tot, f"AI enrichment {done}/{tot}")
        )
        _progress("ai_enrich", total, total, "AI enrichment done")

    topic_summary = _generate_topic_summary(
        ai_enrichments or [], unique_kws, topic_name, 1
    )

    # Store
    _progress("store", 0, total, "Storing chunks...")
    inserted = 0
    all_keywords_for_topic: list[str] = list(unique_kws)

    with connect() as conn:
        for idx, chunk in enumerate(all_chunks):
            seg_tokens = segmented[idx].split()
            chunk_keywords = set(t for t in seg_tokens if len(t) > 1)

            chunk_text_lower = chunk["text"].lower()
            for kw in unique_kws:
                if kw.lower() in chunk_text_lower:
                    chunk_keywords.add(kw.lower())

            ai_summary = ""
            ai_entities = "[]"
            if ai_enrichments and idx < len(ai_enrichments):
                enrichment = ai_enrichments[idx]
                ai_summary = enrichment.get("summary", "")
                for kw in enrichment.get("keywords", []):
                    chunk_keywords.add(kw.lower())
                    all_keywords_for_topic.append(kw)
                ai_entities = json.dumps(enrichment.get("entities", []), ensure_ascii=False)

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
                    f"wiki:{topic_name}",
                    pdf_path,  # Store original PDF path in project_slug for "open original"
                    json.dumps(vectors[idx]),
                    json.dumps(sorted(chunk_keywords), ensure_ascii=False),
                    ai_entities,
                    ai_summary,
                ),
            )
            inserted += 1

            if (idx + 1) % 50 == 0 or idx + 1 == total:
                _progress("store", idx + 1, total, f"Stored {idx + 1}/{total}")

        # Topic-level keywords
        topic_kws_seen: set[str] = set()
        topic_kws_unique: list[str] = []
        for k in all_keywords_for_topic:
            kl = k.lower()
            if kl not in topic_kws_seen and len(k) > 1:
                topic_kws_seen.add(kl)
                topic_kws_unique.append(k)

        conn.execute(
            """
            INSERT INTO tag_segments(build_id, source_file, tag, topic_name, line_start, line_end, summary, keywords_json, entities_json, is_credential)
            VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, 0)
            """,
            (
                build_id,
                pdf_path,
                f"wiki:{topic_name}",
                topic_name,
                total,
                topic_summary,
                json.dumps(topic_kws_unique[:200], ensure_ascii=False),
                json.dumps({"category": category}),
            ),
        )

        conn.commit()

    summary = f"Ingested PDF '{pdf.name}' → {inserted} chunks as topic '{topic_name}'"
    _progress("done", inserted, total, summary)

    return {
        "inserted": inserted,
        "files": 1,
        "topic": topic_name,
        "md_path": md_path,
        "pdf_path": pdf_path,
        "message": summary,
    }
