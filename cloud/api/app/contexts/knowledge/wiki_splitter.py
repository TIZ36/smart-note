"""Markdown H2 splitter for wiki processing.

Pure function. Given a markdown document, returns the list of
chapters: a leading "preamble" plus one entry per H2 heading. No
recursion into H3/H4 — those stay inside the parent chapter and get
paragraph-chunked downstream (see docs/processing-pipeline.md §4.2).

Edge cases handled (each is a unit test in test_wiki_splitter.py):
  - Fenced code blocks containing `## stuff` MUST NOT split
  - Setext-style H2 (`Title\\n---+`) recognized as H2
  - Setext-style H1 (`Title\\n===+`) NOT a split point — it's H1
  - Indented "headings" (4+ leading spaces) treated as code
  - CRLF / lone CR normalized to LF before lexing
  - Multilingual heading titles preserved verbatim
  - Doc with no H2 at all → one chapter spanning the whole doc
  - Doc starting directly with H2 (no preamble text) → empty preamble
    chapter omitted
  - Heading with trailing ATX closers (`## Title ##`) stripped from title
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass

# ATX H2: exactly two `#`, then required whitespace, then title.
# We deliberately match `^## ` not `^##+` so H3+ never split.
_ATX_H2 = re.compile(r"^##\s+(.+?)\s*#*\s*$")

# Setext underline: 3+ `-` (H2) or 3+ `=` (H1) on a line by itself,
# allowing trailing whitespace. We split on `-` only.
_SETEXT_H2 = re.compile(r"^-{3,}\s*$")
_SETEXT_H1 = re.compile(r"^={3,}\s*$")

# Fenced code block opener. Standard CommonMark allows ``` or ~~~,
# optionally with an info string. Same fence char + length closes.
_FENCE = re.compile(r"^(?P<fence>(?:```+|~~~+))\s*[^\s`]*\s*$")

# Indented code: 4+ leading spaces (or 1 leading tab) starts a code
# block in CommonMark. We treat such lines as never being a heading.
_INDENTED = re.compile(r"^(?: {4,}|\t)")


@dataclass(frozen=True)
class Chapter:
    ord: int           # 0-based position in doc
    title: str         # heading text, verbatim except trimmed
    anchor: str        # slugified title (URL-safe, lower-snake-ish)
    level: int         # always 2 for v1.2 H2-only mode
    line_start: int    # 1-based; for the implicit preamble: 1
    line_end: int      # 1-based, inclusive
    text: str          # the raw chapter content (heading + body)


def split_wiki(content: str) -> list[Chapter]:
    """Split a markdown document into chapters at H2 boundaries.

    The first returned entry is the "preamble" — content before the
    first H2 heading. If the doc opens directly with an H2 (no body
    above), the preamble is omitted (no zero-line chapter is emitted).

    A doc with no H2 at all returns a single chapter spanning the
    entire document, titled after its first non-empty line (or
    "preamble" if the doc is empty).
    """
    if not content:
        return []

    # Normalize line endings before lexing — see docs §4.2 edge case.
    text = content.replace("\r\n", "\n").replace("\r", "\n")
    lines = text.split("\n")

    boundaries: list[tuple[int, str]] = []  # (line_index_0_based, title)
    in_fence = False
    fence_marker = ""

    i = 0
    while i < len(lines):
        line = lines[i]

        if in_fence:
            # Closing fence: must match the opener's char and be at
            # least as long. Conservative: any fence-shaped line ends
            # the block. This is wrong for nested fences (rare in
            # practice) but never spuriously splits.
            if line.lstrip().startswith(fence_marker):
                in_fence = False
                fence_marker = ""
            i += 1
            continue

        m_open = _FENCE.match(line)
        if m_open:
            in_fence = True
            fence_marker = m_open.group("fence")
            i += 1
            continue

        # Indented code = not a heading, not a fence either.
        if _INDENTED.match(line):
            i += 1
            continue

        # ATX H2.
        m_atx = _ATX_H2.match(line)
        if m_atx:
            boundaries.append((i, m_atx.group(1).strip()))
            i += 1
            continue

        # Setext: heading is line N, underline is line N+1. Title text
        # cannot be empty, cannot itself be a heading, and the line
        # before underline must be plain prose. Setext H1 (`=`) is
        # NOT a split point — we only care about H2 boundaries.
        if i + 1 < len(lines):
            nxt = lines[i + 1]
            if _SETEXT_H2.match(nxt) and line.strip() and not _ATX_H2.match(line):
                boundaries.append((i, line.strip()))
                i += 2
                continue
            # Setext H1 — skip the underline so we don't accidentally
            # treat the H1 line as content that starts a paragraph
            # whose H2 detection runs on the underline.
            if _SETEXT_H1.match(nxt) and line.strip():
                i += 2
                continue

        i += 1

    # Build chapters from boundaries.
    chapters: list[Chapter] = []
    total = len(lines)
    seen_anchors: dict[str, int] = {}

    def _next_anchor(title: str) -> str:
        base = _slugify(title)
        if base not in seen_anchors:
            seen_anchors[base] = 0
            return base
        seen_anchors[base] += 1
        return f"{base}-{seen_anchors[base]}"

    if not boundaries:
        # No H2 found. The whole doc is one chapter; title from the
        # first non-empty line (or fallback). line_start/line_end use
        # the actual doc bounds.
        title = next((ln.strip() for ln in lines if ln.strip()), "preamble")
        return [Chapter(
            ord=0,
            title=title,
            anchor=_slugify(title),
            level=2,
            line_start=1,
            line_end=max(1, total),
            text=text,
        )]

    # Preamble: lines [0, boundaries[0]-1]. Skip if empty.
    first_h2_idx = boundaries[0][0]
    preamble_lines = lines[:first_h2_idx]
    if any(ln.strip() for ln in preamble_lines):
        chapters.append(Chapter(
            ord=0,
            title="preamble",
            anchor=_next_anchor("preamble"),
            level=2,
            line_start=1,
            line_end=first_h2_idx,
            text="\n".join(preamble_lines),
        ))

    # Each H2 boundary opens a chapter that runs until the next
    # boundary (or end of doc).
    for k, (idx, title) in enumerate(boundaries):
        end_idx = boundaries[k + 1][0] - 1 if k + 1 < len(boundaries) else total - 1
        ord_idx = len(chapters)
        chapters.append(Chapter(
            ord=ord_idx,
            title=title,
            anchor=_next_anchor(title),
            level=2,
            line_start=idx + 1,
            line_end=end_idx + 1,
            text="\n".join(lines[idx:end_idx + 1]),
        ))

    return chapters


_SLUG_TRIM = re.compile(r"[-\s]+")
_SLUG_KEEP = re.compile(r"[^\w一-鿿぀-ヿ가-힯\-]+", re.UNICODE)


def _slugify(title: str) -> str:
    """Anchor-friendly slug. Keeps CJK / Hangul as-is (they're
    URL-safe in modern browsers and visually meaningful), strips ASCII
    punctuation, replaces whitespace runs with a single hyphen.

    Lowercased — the slug is a navigational id, not display text."""
    if not title:
        return "section"
    # Normalize so combining marks don't desync byte-vs-char counts.
    s = unicodedata.normalize("NFKC", title).strip().lower()
    s = _SLUG_KEEP.sub("-", s)
    s = _SLUG_TRIM.sub("-", s).strip("-")
    return s or "section"
