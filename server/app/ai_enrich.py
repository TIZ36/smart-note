"""AI-powered tag classification for raw note files.

Classifies contiguous line ranges into fixed tags.
Output: [{tag, line_start, line_end, summary, keywords, entities}, ...]

Uses concurrent API calls for large files.
"""

from __future__ import annotations

import json
import logging
import os
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests

from app.config import settings
from app.tags import get_tag_list_for_prompt

logger = logging.getLogger(__name__)

# Process ~150 lines per API call (enough context for paragraph continuity)
LINES_PER_BATCH = 150
# Overlap lines between batches to avoid splitting paragraphs
OVERLAP = 10
MAX_CONCURRENCY = int(os.environ.get("INGEST_CONCURRENCY", "600"))


def _build_system_prompt() -> str:
    tag_list = get_tag_list_for_prompt()
    return f"""You are a note classifier. You receive a block of raw notes (with line numbers) and must classify them into tag segments.

AVAILABLE TAGS:
{tag_list}

YOUR TASK:
1. Group consecutive lines that belong to the same topic into segments
2. Assign each segment ONE primary tag AND optionally secondary tags from the list
3. Keep continuous/related content TOGETHER — do NOT split a paragraph across tags
4. For each segment, provide a brief summary

OUTPUT FORMAT — JSON array of segments:
[
  {{
    "tag": "learn",
    "secondary_tags": ["work"],
    "topic_name": "Git Rebase",
    "line_start": 1,
    "line_end": 15,
    "summary": "Git rebase workflow notes and branch management tips",
    "keywords": ["git", "rebase", "workflow"],
    "entities": [{{"name": "git", "type": "tool"}}],
    "is_credential": false
  }},
  {{
    "tag": "password",
    "topic_name": "OpenAI Keys",
    "line_start": 16,
    "line_end": 18,
    "summary": "OpenAI API key for production",
    "keywords": ["openai", "api_key"],
    "entities": [{{"name": "OpenAI", "type": "service"}}],
    "is_credential": true
  }}
]

RULES:
- Line numbers must be EXACT (from the input)
- Every line must belong to exactly ONE segment (no gaps, no overlaps)
- Prefer larger segments — don't create a new segment for every line
- "password" tag: use for ANY credentials (API keys, tokens, passwords, connection strings)
- Keep related lines together even if they span different sub-topics
- "topic_name": a precise 1-3 word name for this specific segment (e.g., "Git Rebase", "MySQL索引", "API密钥"). Use content language.
- Reply with ONLY the JSON array, no markdown fences, no explanation"""


# Global token counter for the current ingest run (thread-safe)
import threading
_token_lock = threading.Lock()
_token_usage = {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}


def reset_token_usage():
    with _token_lock:
        _token_usage["prompt_tokens"] = 0
        _token_usage["completion_tokens"] = 0
        _token_usage["total_tokens"] = 0


def get_token_usage() -> dict:
    with _token_lock:
        return dict(_token_usage)


def _call_llm(system: str, user: str) -> str | None:
    api_key = settings.provider_api_key
    if not api_key:
        return None
    model = getattr(settings, "ingest_ai_model", None) or settings.provider_chat_model
    base_url = settings.provider_base_url.rstrip("/")
    try:
        resp = requests.post(
            f"{base_url}/chat/completions",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json={
                "model": model,
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
                "temperature": 0.0,
                "max_tokens": 4000,
            },
            timeout=60,
        )
        resp.raise_for_status()
        data = resp.json()
        # Track token usage (thread-safe)
        usage = data.get("usage", {})
        with _token_lock:
            _token_usage["prompt_tokens"] += usage.get("prompt_tokens", 0)
            _token_usage["completion_tokens"] += usage.get("completion_tokens", 0)
            _token_usage["total_tokens"] += usage.get("total_tokens", 0)
        return data["choices"][0]["message"]["content"]
    except Exception as e:
        logger.warning("AI classify call failed: %s", e)
        return None


def classify_lines(
    lines: list[str],
    on_progress: callable | None = None,
) -> list[dict]:
    """Classify all lines into tag segments using concurrent AI calls.

    Args:
        lines: raw file lines (0-indexed in list, but line numbers are 1-based)
        on_progress: optional callback(done_lines, total_lines)

    Returns:
        List of segments: [{tag, line_start, line_end, summary, keywords, entities, is_credential}]
    """
    if not getattr(settings, "ingest_ai_enabled", False):
        # Fallback: everything is "others"
        return [{
            "tag": "others",
            "line_start": 1,
            "line_end": len(lines),
            "summary": "Unclassified content",
            "keywords": [],
            "entities": [],
            "is_credential": False,
        }] if lines else []

    total = len(lines)
    system_prompt = _build_system_prompt()

    # Build batches with overlap
    batches: list[tuple[int, int]] = []  # (start_line_1based, end_line_1based)
    i = 0
    while i < total:
        end = min(i + LINES_PER_BATCH, total)
        batches.append((i + 1, end))  # 1-based line numbers
        i = end - OVERLAP if end < total else total

    # Process batches concurrently
    all_segments: list[tuple[int, list[dict]]] = []
    done_count = 0

    def _process_batch(batch_idx: int, start: int, end: int) -> tuple[int, list[dict]]:
        # Build numbered lines for the prompt
        numbered = []
        for ln in range(start, end + 1):
            if ln - 1 < len(lines):
                numbered.append(f"L{ln}: {lines[ln - 1]}")
        user_msg = f"Classify lines {start}-{end}:\n\n" + "\n".join(numbered)
        raw = _call_llm(system_prompt, user_msg)
        if not raw:
            return batch_idx, [{"tag": "others", "line_start": start, "line_end": end, "summary": "", "keywords": [], "entities": [], "is_credential": False}]
        return batch_idx, _parse_segments(raw, start, end)

    with ThreadPoolExecutor(max_workers=min(MAX_CONCURRENCY, len(batches))) as executor:
        futures = {
            executor.submit(_process_batch, idx, s, e): idx
            for idx, (s, e) in enumerate(batches)
        }
        for future in as_completed(futures):
            batch_idx, segments = future.result()
            all_segments.append((batch_idx, segments))
            done_count += 1
            if on_progress:
                on_progress(
                    min(done_count * LINES_PER_BATCH, total),
                    total,
                )

    # Sort by batch order and merge overlapping segments
    all_segments.sort(key=lambda x: x[0])
    merged = _merge_segments([seg for _, segs in all_segments for seg in segs], total)

    return merged


def _parse_segments(raw: str, expected_start: int, expected_end: int) -> list[dict]:
    """Parse AI response into segment list."""
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

        segments = []
        for item in parsed:
            seg = {
                "tag": item.get("tag", "others"),
                "secondary_tags": item.get("secondary_tags", []),
                "topic_name": item.get("topic_name", ""),
                "line_start": int(item.get("line_start", expected_start)),
                "line_end": int(item.get("line_end", expected_end)),
                "summary": item.get("summary", ""),
                "keywords": item.get("keywords", []),
                "entities": item.get("entities", []),
                "is_credential": bool(item.get("is_credential", False)),
            }
            # Clamp to expected range
            seg["line_start"] = max(seg["line_start"], expected_start)
            seg["line_end"] = min(seg["line_end"], expected_end)
            if seg["line_end"] >= seg["line_start"]:
                segments.append(seg)

        return segments or [{"tag": "others", "line_start": expected_start, "line_end": expected_end, "summary": "", "keywords": [], "entities": [], "is_credential": False}]
    except (json.JSONDecodeError, TypeError, KeyError) as e:
        logger.warning("Failed to parse classify response: %s", e)
        return [{"tag": "others", "line_start": expected_start, "line_end": expected_end, "summary": "", "keywords": [], "entities": [], "is_credential": False}]


def _merge_segments(segments: list[dict], total_lines: int) -> list[dict]:
    """Merge overlapping segments from batch boundaries.

    When two batches overlap, the segment that covers the overlap region
    from the first batch takes priority, and the second batch's segment
    is trimmed.
    """
    if not segments:
        return []

    # Sort by line_start
    segments.sort(key=lambda s: (s["line_start"], -s["line_end"]))

    merged: list[dict] = []
    covered_up_to = 0

    for seg in segments:
        if seg["line_start"] <= covered_up_to:
            # This segment overlaps with already covered area
            if seg["line_end"] <= covered_up_to:
                continue  # Fully covered, skip
            # Trim the start
            seg = {**seg, "line_start": covered_up_to + 1}

        if seg["line_end"] < seg["line_start"]:
            continue

        # Merge with previous if same tag and adjacent
        if merged and merged[-1]["tag"] == seg["tag"] and seg["line_start"] <= merged[-1]["line_end"] + 2:
            merged[-1]["line_end"] = max(merged[-1]["line_end"], seg["line_end"])
            if seg["summary"] and not merged[-1]["summary"]:
                merged[-1]["summary"] = seg["summary"]
            merged[-1]["keywords"] = list(set(merged[-1]["keywords"] + seg["keywords"]))
        else:
            merged.append(seg)

        covered_up_to = max(covered_up_to, seg["line_end"])

    return merged
