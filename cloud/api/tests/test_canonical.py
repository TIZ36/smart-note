"""Tests for app.infra.canonical — the dedup hash invariants.

Run from cloud/api/:
    PYTHONPATH=. pytest tests/test_canonical.py -v

The whole point of canonical.py is that two byte sequences that
"mean the same thing" hash to the same value, while two that mean
different things don't. The cases below codify that contract;
breaking any of them invalidates production chunk_blobs and forces
a workspace-wide rebuild.
"""

from __future__ import annotations

import pytest

from app.infra.canonical import canonical_sha, canonicalize, sha256_hex


# ── 1. Empty / whitespace-only ─────────────────────────────────

@pytest.mark.parametrize("text,expected", [
    ("", ""),
    (" ", ""),
    ("\t", ""),
    ("\n", ""),
    ("\r\n", ""),
    ("   \t  \n  ", ""),
    ("\r\r\r", ""),
])
def test_whitespace_only_collapses_to_empty(text, expected):
    assert canonicalize(text) == expected


# ── 2. UTF-8 BOM stripping ─────────────────────────────────────

def test_utf8_bom_is_stripped():
    assert canonicalize("﻿hello") == "hello"


def test_utf8_bom_only_at_start():
    # BOM in the middle of text is not treated specially.
    assert canonicalize("hello﻿world") == "hello﻿world"


def test_utf8_bom_then_whitespace():
    assert canonicalize("﻿   hello   ") == "hello"


# ── 3. Line ending normalization ───────────────────────────────

@pytest.mark.parametrize("text,expected", [
    ("a\r\nb",   "a\nb"),
    ("a\rb",     "a\nb"),
    ("a\nb",     "a\nb"),
    ("a\r\n\r\nb", "a\n\nb"),
    ("a\r\rb",   "a\n\nb"),
    ("a\r\nb\rc\nd", "a\nb\nc\nd"),
])
def test_line_endings_normalize_to_lf(text, expected):
    assert canonicalize(text) == expected


def test_crlf_then_lf_does_not_double_collapse():
    # If we did `\r → \n` first, "\r\n" would become "\n\n" — wrong.
    # Order is: \r\n first, then lone \r.
    assert canonicalize("a\r\nb\r\nc") == "a\nb\nc"


# ── 4. Inline whitespace runs collapse ─────────────────────────

@pytest.mark.parametrize("text,expected", [
    ("a  b",       "a b"),
    ("a   b",      "a b"),
    ("a\tb",       "a b"),
    ("a\t\tb",     "a b"),
    ("a \t b",     "a b"),
    ("a\t \t  b",  "a b"),
])
def test_inline_runs_collapse(text, expected):
    assert canonicalize(text) == expected


def test_outer_whitespace_trimmed():
    assert canonicalize("   hello world   ") == "hello world"


def test_outer_tabs_trimmed():
    assert canonicalize("\t\thello\t\t") == "hello"


# ── 5. Newlines preserved (multi-line content stays multi-line) ─

def test_newlines_are_not_collapsed_to_spaces():
    # The collapse regex is `[ \t]+`, NOT `\s+`; LF survives.
    assert canonicalize("line one\nline two") == "line one\nline two"


def test_blank_line_between_paragraphs_preserved():
    assert canonicalize("para 1\n\npara 2") == "para 1\n\npara 2"


def test_three_blank_lines_preserved():
    # If we wanted to collapse blank-line runs, that'd be a separate
    # decision. Today we keep them — preserves visual rhythm.
    assert canonicalize("a\n\n\n\nb") == "a\n\n\n\nb"


# ── 6. Mixed real-world drift ──────────────────────────────────

def test_crlf_with_trailing_spaces():
    # Common Windows-edited file: each line ends with "  \r\n" (two
    # spaces before the line break, often left by IDEs).
    text = "first line  \r\nsecond line  \r\n"
    assert canonicalize(text) == "first line\nsecond line"


def test_tab_indented_code_collapses_run_but_keeps_lf():
    text = "def f():\n\treturn  42\n"
    assert canonicalize(text) == "def f():\n return 42"


def test_smartquotes_preserved():
    # Curly quotes, dashes, and other "smart" punctuation are NOT
    # normalized — they're semantic content.
    assert canonicalize("“hello”") == "“hello”"
    assert canonicalize("hello—world") == "hello—world"


# ── 7. Unicode whitespace deliberately preserved ───────────────

def test_nbsp_preserved():
    # Non-breaking space (U+00A0) is NOT ASCII space; users often
    # type it deliberately (or get it from copy-paste from Word).
    assert canonicalize("hello world") == "hello world"


def test_ideographic_space_preserved():
    # Chinese fullwidth space (U+3000). Different visual width and
    # cultural meaning from ASCII space — collapsing would lose info.
    assert canonicalize("你好　世界") == "你好　世界"


def test_zwsp_preserved():
    # Zero-width space (U+200B). Edge case; preserved for the same
    # reason — semantic content, not formatting noise we own.
    assert canonicalize("a​b") == "a​b"


def test_em_space_preserved():
    # U+2003 EM SPACE.
    assert canonicalize("a b") == "a b"


# ── 8. Unicode content is byte-faithful ────────────────────────

def test_emoji_preserved():
    assert canonicalize("hello 👋 world") == "hello 👋 world"


def test_emoji_with_zwj_sequence_preserved():
    # 👨‍👩‍👧 is a ZWJ sequence — a single visible glyph made of
    # multiple code points joined by U+200D. Must survive untouched.
    text = "family: 👨‍👩‍👧"
    assert canonicalize(text) == text


def test_chinese_and_punctuation():
    # Chinese punctuation has different code points than ASCII —
    # don't collapse.
    assert canonicalize("你好，世界！") == "你好，世界！"


def test_japanese_with_inline_spaces():
    # Mixed ASCII spaces inside JP text still collapse.
    assert canonicalize("こんにちは  world") == "こんにちは world"


# ── 9. Code-block-shaped input ─────────────────────────────────

def test_fenced_code_block_lines_kept():
    text = "```python\ndef f():\n    return 1\n```\n"
    expected = "```python\ndef f():\n return 1\n```"
    assert canonicalize(text) == expected


def test_indented_code_block():
    # Outer strip eats the leading 4 spaces on line 1; line 2's
    # leading run survives strip and collapses to a single space.
    # This is asymmetric but desired: the document opens at the
    # first non-whitespace char; subsequent indentation is "real".
    text = "    foo()\n    bar()\n"
    expected = "foo()\n bar()"
    assert canonicalize(text) == expected


def test_markdown_table_pipes_preserved():
    text = "| a | b |\n|---|---|\n| 1 | 2 |"
    assert canonicalize(text) == text


# ── 10. Idempotency ────────────────────────────────────────────

@pytest.mark.parametrize("text", [
    "",
    "hello",
    "a\r\nb\tc  d",
    "﻿   foo\n   bar   ",
    "你好　世界  abc",
    "👨‍👩‍👧",
])
def test_idempotent(text):
    once = canonicalize(text)
    twice = canonicalize(once)
    assert once == twice


# ── 11. Different inputs that SHOULD hash the same ─────────────

def test_dedup_pair_crlf_vs_lf():
    a = "hello\r\nworld\r\n"
    b = "hello\nworld"
    assert canonical_sha(a) == canonical_sha(b)


def test_dedup_pair_trailing_whitespace():
    a = "hello world"
    b = "hello world   "
    assert canonical_sha(a) == canonical_sha(b)


def test_dedup_pair_tab_vs_space():
    a = "hello\tworld"
    b = "hello world"
    assert canonical_sha(a) == canonical_sha(b)


def test_dedup_pair_bom_vs_no_bom():
    a = "﻿first paragraph"
    b = "first paragraph"
    assert canonical_sha(a) == canonical_sha(b)


def test_dedup_pair_mixed_line_endings():
    a = "alpha\r\nbeta\rgamma\ndelta\r\n"
    b = "alpha\nbeta\ngamma\ndelta"
    assert canonical_sha(a) == canonical_sha(b)


def test_dedup_pair_per_line_trailing_space():
    # Editor drift: one writer saves with trailing spaces on every
    # line, another writer strips them. They must hash the same.
    a = "alpha   \nbeta \t\ngamma\n"
    b = "alpha\nbeta\ngamma"
    assert canonical_sha(a) == canonical_sha(b)


def test_per_line_rstrip_does_not_eat_leading_indent():
    # Per-line rstrip is the right edge only; indentation survives
    # for non-first lines (first line's indent is already gone via
    # outer strip).
    text = "first\n    second   \n\tthird  \n"
    # Walking through:
    #   strip() → "first\n    second   \n\tthird"
    #   per-line rstrip → "first\n    second\n\tthird"
    #   inline collapse → "first\n second\n third"
    assert canonicalize(text) == "first\n second\n third"


# ── 12. Different inputs that SHOULD NOT hash the same ─────────

def test_distinguish_case():
    # Case is preserved — "Hello" and "hello" must hash differently.
    assert canonical_sha("Hello") != canonical_sha("hello")


def test_distinguish_nbsp_vs_space():
    # NBSP is preserved while ASCII space collapses; that's exactly
    # the boundary that lets `"a b"` and `"a b"` distinguish.
    assert canonical_sha("a b") != canonical_sha("a b")


def test_distinguish_lf_vs_no_lf():
    # Line break carries meaning; same words separated by space vs
    # newline are different content.
    assert canonical_sha("a b") != canonical_sha("a\nb")


def test_distinguish_blank_line_count():
    # Blank-line runs preserved → different paragraph counts hash
    # differently.
    assert canonical_sha("a\n\nb") != canonical_sha("a\n\n\nb")


def test_distinguish_smartquote_vs_ascii():
    assert canonical_sha("\"hello\"") != canonical_sha("“hello”")


# ── 13. Hash is stable / deterministic ─────────────────────────

def test_sha_format():
    h = sha256_hex("hello")
    # 256 bits = 64 hex chars; lowercase per Python's hexdigest().
    assert len(h) == 64
    assert all(c in "0123456789abcdef" for c in h)


def test_sha_known_value():
    # Pinned: regression catch if the algorithm or encoding changes.
    # Computed via: echo -n hello | sha256sum
    assert sha256_hex("hello") == \
        "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"


def test_canonical_sha_known_value():
    # Pinned regression: canonicalize("  hello  ") = "hello", whose
    # sha is the same as the known value above.
    assert canonical_sha("  hello  ") == \
        "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"


def test_canonical_sha_stable_across_calls():
    text = "line one\nline two\n"
    h1 = canonical_sha(text)
    h2 = canonical_sha(text)
    h3 = canonical_sha(text)
    assert h1 == h2 == h3
