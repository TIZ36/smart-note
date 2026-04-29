"""Canonical text representation for hash-based dedup.

The hash of `canonicalize(text)` is the dedup key for both
documents (`documents.content_sha256`) and chunks
(`chunk_blobs.content_sha`). Anything that compares semantically
identical content but might disagree on whitespace / line endings /
byte-order marks should run through here first.

Spec (frozen for v1.2 — bumping the algorithm invalidates every
existing chunk_sha and forces a workspace-wide rebuild):

  1. Strip a leading UTF-8 BOM (U+FEFF). Other BOM forms shouldn't
     reach Postgres TEXT columns; if they do, they're preserved.
  2. Normalize line endings: CRLF (`\\r\\n`) and lone CR (`\\r`) become
     LF (`\\n`).
  3. Trim outer whitespace.
  4. Per-line `rstrip` of ASCII space/tab. Catches editor drift where
     some save "line  \\n" and others save "line\\n".
  5. Collapse runs of ASCII space/tab to a single space — but only
     within a line. Multi-line structure is preserved (the LF stays).

Deliberately NOT done — case stays as-is (semantically meaningful for
code, product names, identifiers); unicode whitespace (NBSP U+00A0,
ideographic space U+3000, ZWSP U+200B, etc.) is preserved (these
encode intent in Chinese / Japanese typography and should not collapse
to ASCII space). Hashing is for dedup, not normalization — when in
doubt we keep the original byte and let two distinct authoring
conventions hash distinctly.

Properties any caller can rely on:
  - canonicalize is idempotent: canonicalize(canonicalize(x)) == canonicalize(x)
  - canonicalize is content-only: no system state, no clock, no locale
  - sha256_hex is hex-string deterministic for the same input
"""

from __future__ import annotations

import hashlib
import re

# Compile once. The character class is intentional — we collapse only
# ASCII space (U+0020) and HT (U+0009). See module docstring on why
# unicode whitespace is preserved.
_INLINE_WS_RUN = re.compile(r"[ \t]+")

_UTF8_BOM = "﻿"


def canonicalize(text: str) -> str:
    """Return the canonical form of `text`. See module docstring."""
    if not text:
        return ""
    if text.startswith(_UTF8_BOM):
        text = text[len(_UTF8_BOM):]
    # CRLF → LF first, then lone CR → LF. Order matters: doing them in
    # the other order would turn `\r\n` into `\n\n`.
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = text.strip()
    # Per-line rstrip BEFORE the inline-run collapse so a line that
    # was "abc  \n" (trailing whitespace before LF) reduces all the
    # way to "abc", not "abc " (single space lingering).
    text = "\n".join(line.rstrip(" \t") for line in text.split("\n"))
    return _INLINE_WS_RUN.sub(" ", text)


def sha256_hex(text: str) -> str:
    """SHA-256 of `text` as a 64-char hex string. Matches the format
    Postgres' `encode(digest(content,'sha256'),'hex')` returns, so a
    Python-computed sha can be compared to a DB-side one without
    transformation."""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def canonical_sha(text: str) -> str:
    """Composition shortcut: `sha256_hex(canonicalize(text))`."""
    return sha256_hex(canonicalize(text))
