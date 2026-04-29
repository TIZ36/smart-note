"""Tests for wiki H2 splitter — the structural pre-step of the wiki
processor. Edge-case coverage tracks docs/processing-pipeline.md §4.2.

Run from cloud/api/:
    PYTHONPATH=. pytest tests/test_wiki_splitter.py -v
"""

from __future__ import annotations

from app.contexts.knowledge.wiki_splitter import Chapter, _slugify, split_wiki


# ── 1. Empty / no-H2 cases ─────────────────────────────────────

def test_empty_document():
    assert split_wiki("") == []


def test_single_blank_line_returns_one_chapter():
    chapters = split_wiki("\n")
    # Whitespace-only doc still produces one chapter so the wiki UI
    # has something to render.
    assert len(chapters) == 1
    assert chapters[0].title == "preamble"


def test_no_h2_at_all():
    text = "just a few lines\nwith no headings\nat all"
    chapters = split_wiki(text)
    assert len(chapters) == 1
    c = chapters[0]
    assert c.ord == 0
    assert c.title == "just a few lines"
    assert c.line_start == 1
    assert c.line_end == 3


def test_only_h1_no_h2():
    # H1 alone doesn't create a split point — only H2 does.
    text = "# Just an H1\n\nbody text\n"
    chapters = split_wiki(text)
    assert len(chapters) == 1
    assert chapters[0].title == "# Just an H1"


# ── 2. Basic ATX H2 splits ─────────────────────────────────────

def test_two_h2_sections():
    text = "intro line\n\n## First\n\npara 1\n\n## Second\n\npara 2\n"
    chapters = split_wiki(text)
    assert [c.title for c in chapters] == ["preamble", "First", "Second"]
    assert chapters[0].ord == 0
    assert chapters[1].ord == 1
    assert chapters[2].ord == 2


def test_doc_starts_with_h2_no_preamble_emitted():
    text = "## First\n\nbody one\n\n## Second\n\nbody two\n"
    chapters = split_wiki(text)
    assert [c.title for c in chapters] == ["First", "Second"]
    assert chapters[0].line_start == 1


def test_chapter_text_includes_heading():
    text = "## Foo\n\nthe body\n"
    chapters = split_wiki(text)
    assert chapters[0].text.startswith("## Foo")


def test_line_ranges_consecutive():
    text = "## A\nbody A\n## B\nbody B\n## C\nbody C\n"
    chapters = split_wiki(text)
    # Chapter 0 covers lines 1-2, Chapter 1 covers 3-4, etc.
    assert (chapters[0].line_start, chapters[0].line_end) == (1, 2)
    assert (chapters[1].line_start, chapters[1].line_end) == (3, 4)
    assert (chapters[2].line_start, chapters[2].line_end) == (5, 7)


# ── 3. ATX heading edge cases ──────────────────────────────────

def test_atx_with_trailing_closers():
    # `## Title ##` — closers stripped from title.
    text = "## Title ##\n\nbody\n"
    chapters = split_wiki(text)
    assert chapters[0].title == "Title"


def test_h3_does_not_split():
    text = "## Outer\n\n### Inner\n\nbody\n"
    chapters = split_wiki(text)
    assert [c.title for c in chapters] == ["Outer"]


def test_h4_does_not_split():
    text = "## Outer\n\n#### Deep\n\nbody\n"
    chapters = split_wiki(text)
    assert [c.title for c in chapters] == ["Outer"]


def test_h1_does_not_split():
    # Single `#` is H1; doesn't open a chapter in our v1.2 mode.
    text = "## A\nA body\n# Big H1\nstill A\n## B\nB body\n"
    chapters = split_wiki(text)
    assert [c.title for c in chapters] == ["A", "B"]


def test_atx_no_space_after_hashes_is_not_h2():
    # `##Title` (no space) is NOT a heading per CommonMark — we
    # require `\s+` between hashes and title.
    text = "##NoSpace\n\nbody\n## Real\n\nreal body\n"
    chapters = split_wiki(text)
    assert [c.title for c in chapters] == ["preamble", "Real"]


# ── 4. Fenced code blocks ──────────────────────────────────────

def test_h2_inside_fenced_code_block_ignored():
    text = "## Real\n\nbody\n\n```\n## fake heading inside code\n```\n\nmore\n"
    chapters = split_wiki(text)
    assert [c.title for c in chapters] == ["Real"]
    # Body should include the entire code block.
    assert "## fake heading inside code" in chapters[0].text


def test_tilde_fence_also_blocks_h2_detection():
    text = "## Real\n\n~~~markdown\n## fake\n~~~\n## Other\n"
    chapters = split_wiki(text)
    assert [c.title for c in chapters] == ["Real", "Other"]


def test_h2_immediately_after_fence_close():
    text = "## A\n\n```\ncode\n```\n## B\n\nbody\n"
    chapters = split_wiki(text)
    assert [c.title for c in chapters] == ["A", "B"]


def test_unmatched_fence_swallows_rest_of_doc():
    # Conservative behavior: an unclosed fence leaves us in_fence to
    # EOF — no spurious splits. This is the safer error mode (worst
    # case the doc is one big chapter).
    text = "## A\n\n```\nstart of code\n## not a heading\nstill code\n"
    chapters = split_wiki(text)
    assert [c.title for c in chapters] == ["A"]


# ── 5. Indented code (4-space) ─────────────────────────────────

def test_indented_4_spaces_is_not_h2():
    text = "## Real\n\n    ## fake heading indented as code\n\nbody\n"
    chapters = split_wiki(text)
    assert [c.title for c in chapters] == ["Real"]


def test_indented_tab_is_not_h2():
    text = "## Real\n\n\t## fake\n\nbody\n"
    chapters = split_wiki(text)
    assert [c.title for c in chapters] == ["Real"]


def test_3_spaces_indent_not_treated_as_h2():
    # CommonMark allows up to 3 leading spaces before an ATX heading.
    # Our regex requires `^##` at the start — 3-space-indented `##`
    # does NOT split. We err on the strict side: treating it as
    # not-a-heading is safer than the opposite, and 3-space indent is
    # rare in real wikis. With no H2 detected, the splitter falls
    # through to the "no-H2" path: one whole-doc chapter, titled
    # after the first non-empty line.
    text = "   ## Three Spaces\n\nbody\n"
    chapters = split_wiki(text)
    assert len(chapters) == 1
    assert chapters[0].title == "## Three Spaces"


# ── 6. Setext-style headings ───────────────────────────────────

def test_setext_h2_splits():
    # `Title\n---` is a setext H2.
    text = "preamble line\n\nFirst Section\n---\n\nbody one\n\nSecond Section\n---\n\nbody two\n"
    chapters = split_wiki(text)
    assert [c.title for c in chapters] == ["preamble", "First Section", "Second Section"]


def test_setext_h1_does_not_split():
    text = "preamble\n\nBig Title\n===\n\nbody\n## Real H2\n\nh2 body\n"
    chapters = split_wiki(text)
    assert [c.title for c in chapters] == ["preamble", "Real H2"]


def test_setext_mixed_with_atx():
    text = "## Atx Section\n\nbody\n\nSetext Section\n---\n\nmore body\n"
    chapters = split_wiki(text)
    assert [c.title for c in chapters] == ["Atx Section", "Setext Section"]


# ── 7. Line ending normalization ───────────────────────────────

def test_crlf_normalized_before_lexing():
    text = "## Win\r\n\r\nbody one\r\n\r\n## Lose\r\n\r\nbody two\r\n"
    chapters = split_wiki(text)
    assert [c.title for c in chapters] == ["Win", "Lose"]


def test_lone_cr_normalized():
    text = "## Old Mac\r\rbody\r\r## Other\rbody\r"
    chapters = split_wiki(text)
    assert [c.title for c in chapters] == ["Old Mac", "Other"]


# ── 8. Multilingual headings ───────────────────────────────────

def test_chinese_heading_preserved():
    text = "## 一、概述\n\n第一段\n\n## 二、实现\n\n第二段\n"
    chapters = split_wiki(text)
    assert [c.title for c in chapters] == ["一、概述", "二、实现"]


def test_japanese_heading_preserved():
    text = "## はじめに\n\n本文\n\n## 結論\n\n結び\n"
    chapters = split_wiki(text)
    assert [c.title for c in chapters] == ["はじめに", "結論"]


def test_emoji_in_heading_preserved():
    text = "## 🚀 Launch Plan\n\nbody\n"
    chapters = split_wiki(text)
    assert chapters[0].title == "🚀 Launch Plan"


def test_heading_with_trailing_whitespace():
    text = "##   Whitespace Title   \n\nbody\n"
    chapters = split_wiki(text)
    assert chapters[0].title == "Whitespace Title"


# ── 9. Anchors / slugs ─────────────────────────────────────────

def test_anchor_basic_ascii():
    chapters = split_wiki("## Hello World\n\nbody\n")
    assert chapters[0].anchor == "hello-world"


def test_anchor_strips_punctuation():
    chapters = split_wiki("## Q: Why?!\n\nbody\n")
    # Punctuation collapses to hyphens, edges trimmed.
    assert chapters[0].anchor == "q-why"


def test_anchor_chinese_preserved():
    chapters = split_wiki("## 一、概述\n\nbody\n")
    # Chinese chars are URL-safe; we keep them.
    assert chapters[0].anchor == "一-概述"


def test_anchor_dedups_within_doc():
    text = "## Foo\n\na\n\n## Foo\n\nb\n\n## Foo\n\nc\n"
    chapters = split_wiki(text)
    assert [c.anchor for c in chapters] == ["foo", "foo-1", "foo-2"]


def test_anchor_for_empty_title_falls_back():
    assert _slugify("") == "section"
    assert _slugify("###") == "section"  # only punctuation


# ── 10. Boundaries / line numbers ──────────────────────────────

def test_first_h2_at_line_one():
    text = "## At Line One\n\nbody\n"
    # split("\n") on a trailing-LF string yields a trailing empty
    # element, so the doc is 4 lines: ["## At Line One", "", "body", ""].
    chapters = split_wiki(text)
    assert chapters[0].line_start == 1
    assert chapters[0].line_end == 4


def test_no_preamble_when_first_line_is_h2():
    text = "## First\n\nbody\n"
    chapters = split_wiki(text)
    assert len(chapters) == 1


def test_preamble_emitted_when_lines_above_first_h2():
    text = "intro paragraph\n\n## First\n\nbody\n"
    chapters = split_wiki(text)
    assert chapters[0].title == "preamble"
    assert chapters[0].line_start == 1
    assert chapters[0].line_end == 2  # 2 lines of preamble


def test_chapter_text_byte_faithful():
    # The split must preserve raw text exactly within each range —
    # downstream summary_sha relies on byte identity. Trailing LFs
    # become empty trailing lines that belong to the last chapter.
    text = "## Foo\n  body 1\n  body 2\n## Bar\n  body 3\n"
    chapters = split_wiki(text)
    assert chapters[0].text == "## Foo\n  body 1\n  body 2"
    # Last chapter's text spans through the trailing-LF empty line.
    assert chapters[1].text == "## Bar\n  body 3\n"


def test_chapter_count_with_many_h2():
    # 50 H2 sections — confirms no off-by-one in the boundary loop.
    body_blocks = "\n\n".join([f"## Section {i}\n\nbody {i}" for i in range(50)])
    chapters = split_wiki(body_blocks)
    assert len(chapters) == 50
    assert chapters[0].title == "Section 0"
    assert chapters[49].title == "Section 49"


# ── 11. Real-world drift ───────────────────────────────────────

def test_h2_with_link_in_title():
    text = "## [Reference](https://example.com)\n\nbody\n"
    chapters = split_wiki(text)
    # Title preserved including the link syntax.
    assert chapters[0].title == "[Reference](https://example.com)"


def test_blank_lines_between_chapters_count_in_ranges():
    text = "## A\n\n\n\n## B\n\nbody\n"
    chapters = split_wiki(text)
    # Chapter A's body is the blank lines; preserved as part of its text.
    assert chapters[0].text == "## A\n\n\n"
    assert chapters[1].text.startswith("## B")


def test_huge_chapter_body_still_one_chapter():
    body = "lorem ipsum " * 1000
    text = f"## Big\n\n{body}\n"
    chapters = split_wiki(text)
    assert len(chapters) == 1
    assert chapters[0].title == "Big"


# ── 12. Chapter dataclass invariants ───────────────────────────

def test_chapter_is_immutable():
    chapters = split_wiki("## Foo\n\nbody\n")
    c = chapters[0]
    # frozen=True
    try:
        c.title = "Bar"  # type: ignore
    except Exception as e:
        assert "frozen" in str(e) or "cannot" in str(e).lower()
    else:
        raise AssertionError("Chapter should be frozen")


def test_chapter_levels_are_two():
    text = "## A\n\nbody\n\n## B\n\nbody\n"
    chapters = split_wiki(text)
    assert all(c.level == 2 for c in chapters)


def test_chapter_ords_are_zero_based_consecutive():
    text = "preamble\n\n## A\n\n## B\n\n## C\n"
    chapters = split_wiki(text)
    assert [c.ord for c in chapters] == [0, 1, 2, 3]
