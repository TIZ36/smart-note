"""Chinese + English tokenization using jieba for FTS5 indexing."""

from __future__ import annotations

import re

import jieba


# Suppress jieba's loading messages
jieba.setLogLevel(20)


def segment(text: str) -> str:
    """Segment text into space-separated tokens for FTS5.

    - Chinese text is segmented using jieba
    - English words and numbers are preserved as-is
    - Punctuation is stripped
    """
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
    return " ".join(result)


def segment_query(query: str) -> str:
    """Segment a search query for FTS5 MATCH.

    Returns space-separated tokens suitable for FTS5 queries.
    """
    return segment(query)
