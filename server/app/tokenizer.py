"""Chinese + English tokenization using jieba for FTS5 indexing.

Also provides code-aware tokenization that splits identifiers
(camelCase, snake_case) for better code search.
"""

from __future__ import annotations

import re

import jieba


# Suppress jieba's loading messages
jieba.setLogLevel(20)

# Regex for splitting camelCase / PascalCase
_CAMEL_RE1 = re.compile(r"([a-z0-9])([A-Z])")
_CAMEL_RE2 = re.compile(r"([A-Z]+)([A-Z][a-z])")
# Code punctuation to strip (keep underscores, hyphens inside identifiers)
_CODE_PUNCT = re.compile(r"[(){}\[\];,<>!=&|^~@#$%?:\"'`\\]")


def _split_identifier(token: str) -> list[str]:
    """Split a code identifier into constituent words.

    Examples:
        getUserName  → [get, user, name, getusername]
        get_user_name → [get, user, name, get_user_name]
        HTTPServer   → [http, server, httpserver]
        __init__     → [init]
    """
    # Strip leading/trailing underscores
    stripped = token.strip("_")
    if not stripped:
        return []

    # camelCase / PascalCase split
    s = _CAMEL_RE1.sub(r"\1 \2", stripped)
    s = _CAMEL_RE2.sub(r"\1 \2", s)
    # snake_case split
    s = s.replace("_", " ")

    words = [w.lower() for w in s.split() if w and len(w) > 0]
    # Include original compound form for exact matching
    original = stripped.lower()
    result = list(dict.fromkeys(words + [original]))  # dedupe, preserve order
    return [w for w in result if len(w) > 1]


def segment_code(text: str) -> str:
    """Segment code text for FTS5 indexing.

    Splits identifiers (camelCase, snake_case), strips code punctuation,
    and preserves meaningful tokens. Designed for code files.
    """
    # Remove code punctuation
    cleaned = _CODE_PUNCT.sub(" ", text)

    tokens: list[str] = []
    for raw_token in cleaned.split():
        raw_token = raw_token.strip(".")
        if not raw_token:
            continue
        # Split identifiers and add all parts
        parts = _split_identifier(raw_token)
        if parts:
            tokens.extend(parts)
        else:
            # Fallback: just lowercase the token
            low = raw_token.lower()
            if len(low) > 1:
                tokens.append(low)

    return " ".join(tokens)


# ── Domain synonym/abbreviation expansion ──
# Maps abbreviations → full forms for bidirectional matching
SYNONYMS: dict[str, list[str]] = {
    "prd": ["需求文档", "product requirement"],
    "需求": ["requirement", "prd"],
    "技术方案": ["technical design", "架构设计"],
    "上线": ["发布", "部署", "deploy", "release"],
    "发布": ["上线", "deploy", "release"],
    "部署": ["上线", "deploy"],
    "灰度": ["canary", "灰度发布", "canary release"],
    "api": ["接口", "endpoint"],
    "接口": ["api", "endpoint"],
    "bug": ["缺陷", "问题", "defect"],
    "缺陷": ["bug", "defect"],
    "测试": ["test", "qa"],
    "回归": ["regression"],
    "cr": ["code review", "代码评审"],
    "ci": ["持续集成", "continuous integration"],
    "cd": ["持续部署", "continuous deployment"],
    "sdk": ["开发工具包"],
    "ui": ["界面", "用户界面"],
    "ux": ["用户体验"],
}

def _expand_synonyms(tokens: list[str]) -> list[str]:
    """Expand tokens with known synonyms/abbreviations."""
    expanded = list(tokens)
    for tok in tokens:
        lower = tok.lower()
        if lower in SYNONYMS:
            for syn in SYNONYMS[lower]:
                for word in syn.split():
                    if word.lower() not in {t.lower() for t in expanded}:
                        expanded.append(word.lower())
    return expanded


def segment(text: str, is_code: bool = False) -> str:
    """Segment text into space-separated tokens for FTS5.

    Args:
        text: raw text to segment
        is_code: if True, use code-aware segmentation instead of jieba

    - Chinese text is segmented using jieba
    - English words and numbers are preserved as-is
    - Punctuation is stripped
    - Code mode: splits camelCase, snake_case, strips code punctuation
    - Synonym expansion: adds known abbreviation/synonym forms
    """
    if is_code:
        return segment_code(text)

    # jieba.cut handles mixed Chinese/English well
    tokens = jieba.cut(text, cut_all=False)
    # Filter out whitespace and punctuation-only tokens
    result = []
    for tok in tokens:
        tok = tok.strip()
        if not tok:
            continue
        # Skip pure punctuation
        if re.match(r'^[\s\W]+$', tok) and not re.match(r'^[\w]+$', tok):
            continue
        result.append(tok.lower())

    # Expand synonyms for better recall
    result = _expand_synonyms(result)
    return " ".join(result)


def segment_query(query: str) -> str:
    """Segment a search query for FTS5 MATCH.

    Returns space-separated tokens suitable for FTS5 queries.
    """
    return segment(query)
