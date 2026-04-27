"""AI-powered tag classification for raw note content — cloud version.

Ported from `server/app/ai_enrich.py`. Key changes vs the local version:

* Provider config (api_key / base_url / model) is passed in as parameters
  rather than read from a global `settings` singleton. This is the
  precondition for the executor-registry design: each enrich job may use
  a different key source (cloud pool / device BYOK relay / CC MCP pull).
* Tag list is passed in too — the cloud has no single "the tags" the
  way local does; eventually it'll come from workspace preferences.
* No threading module for token counters — `run_classify` returns usage
  alongside the segments so the caller (dispatcher) can credit the
  right billing bucket.
* Still synchronous HTTP (requests) for now; will become httpx-async when
  the dispatcher needs it. The logic is identical so the port is
  verifiable by diff.

Output format unchanged: [{tag, line_start, line_end, summary,
keywords, entities, is_credential, topic_name, secondary_tags}, ...]
"""

from __future__ import annotations

import json
import logging
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from typing import Callable

import httpx

logger = logging.getLogger(__name__)

LINES_PER_BATCH = 150
OVERLAP = 10
DEFAULT_MAX_CONCURRENCY = 16  # cloud pods are smaller than a dev laptop

DEFAULT_TAGS = [
    "learn", "work", "life", "todo", "idea",
    "password", "reference", "others",
]


@dataclass
class ProviderConfig:
    """Everything the classifier needs to talk to one LLM."""
    api_key: str
    base_url: str
    model: str
    timeout_sec: float = 60.0
    max_tokens: int = 4000
    # How many batch calls to fire in parallel. Old default was 16
    # (sized for OpenAI tier-1 RPM); deepseek + most self-hosted
    # gateways tolerate ~256 comfortably and the user reports good
    # results at 500 with deepseek. Keep an explicit ceiling here so
    # a typo doesn't DDoS the provider.
    max_concurrency: int = 64


@dataclass
class ClassifyResult:
    segments: list[dict]
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0
    failed_batches: int = 0


def _build_system_prompt(tags: list[str]) -> str:
    tag_list = "\n".join(f"- {t}" for t in tags)
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
  }}
]

RULES:
- Line numbers must be EXACT (from the input)
- Every line must belong to exactly ONE segment (no gaps, no overlaps)
- Prefer larger segments — don't create a new segment for every line
- "password" tag: use for ANY credentials (API keys, tokens, passwords, connection strings)
- "topic_name": 1-3 word name in the content language
- Reply with ONLY the JSON array, no markdown fences, no explanation"""


def _call_llm(cfg: ProviderConfig, system: str, user: str) -> tuple[str | None, dict]:
    if not cfg.api_key:
        return None, {}
    base = cfg.base_url.rstrip("/")
    try:
        with httpx.Client(timeout=cfg.timeout_sec) as client:
            resp = client.post(
                f"{base}/chat/completions",
                headers={
                    "Authorization": f"Bearer {cfg.api_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": cfg.model,
                    "messages": [
                        {"role": "system", "content": system},
                        {"role": "user", "content": user},
                    ],
                    "temperature": 0.0,
                    "max_tokens": cfg.max_tokens,
                },
            )
            resp.raise_for_status()
            data = resp.json()
        return data["choices"][0]["message"]["content"], data.get("usage", {}) or {}
    except Exception as e:
        logger.warning("AI classify call failed: %s", e)
        return None, {}


def run_classify(
    lines: list[str],
    provider: ProviderConfig,
    tags: list[str] | None = None,
    max_concurrency: int = DEFAULT_MAX_CONCURRENCY,
    on_progress: Callable[[int, int], None] | None = None,
) -> ClassifyResult:
    """Classify raw lines into tag segments. No delegate mode here — cloud
    always executes; delegation lives at the dispatcher layer in
    `services/enrich/dispatcher.py`."""

    result = ClassifyResult(segments=[])

    if not lines:
        return result

    total = len(lines)
    used_tags = tags or DEFAULT_TAGS
    system_prompt = _build_system_prompt(used_tags)

    # Build overlapping batches
    batches: list[tuple[int, int]] = []
    i = 0
    while i < total:
        end = min(i + LINES_PER_BATCH, total)
        batches.append((i + 1, end))
        i = end - OVERLAP if end < total else total

    all_segments: list[tuple[int, list[dict]]] = []
    done_count = 0

    def _process_batch(batch_idx: int, start: int, end: int) -> tuple[int, list[dict], dict]:
        numbered = [f"L{ln}: {lines[ln - 1]}" for ln in range(start, end + 1) if ln - 1 < len(lines)]
        user_msg = f"Classify lines {start}-{end}:\n\n" + "\n".join(numbered)
        raw, usage = _call_llm(provider, system_prompt, user_msg)
        if not raw:
            return batch_idx, [{"tag": "others", "line_start": start, "line_end": end, "summary": "", "keywords": [], "entities": [], "is_credential": False}], usage
        return batch_idx, _parse_segments(raw, start, end), usage

    with ThreadPoolExecutor(max_workers=min(max_concurrency, len(batches))) as executor:
        futures = {
            executor.submit(_process_batch, idx, s, e): idx
            for idx, (s, e) in enumerate(batches)
        }
        for future in as_completed(futures):
            batch_idx, segments, usage = future.result()
            all_segments.append((batch_idx, segments))
            result.prompt_tokens += usage.get("prompt_tokens", 0)
            result.completion_tokens += usage.get("completion_tokens", 0)
            result.total_tokens += usage.get("total_tokens", 0)
            if not segments or (len(segments) == 1 and segments[0].get("tag") == "others" and not segments[0].get("summary")):
                result.failed_batches += 1
            done_count += 1
            if on_progress:
                on_progress(min(done_count * LINES_PER_BATCH, total), total)

    all_segments.sort(key=lambda x: x[0])
    result.segments = _merge_segments([seg for _, segs in all_segments for seg in segs], total)
    return result


def _parse_segments(raw: str, expected_start: int, expected_end: int) -> list[dict]:
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

        out: list[dict] = []
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
            seg["line_start"] = max(seg["line_start"], expected_start)
            seg["line_end"] = min(seg["line_end"], expected_end)
            if seg["line_end"] >= seg["line_start"]:
                out.append(seg)

        return out or [{"tag": "others", "line_start": expected_start, "line_end": expected_end, "summary": "", "keywords": [], "entities": [], "is_credential": False}]
    except (json.JSONDecodeError, TypeError, KeyError) as e:
        logger.warning("Failed to parse classify response: %s", e)
        return [{"tag": "others", "line_start": expected_start, "line_end": expected_end, "summary": "", "keywords": [], "entities": [], "is_credential": False}]


def _merge_segments(segments: list[dict], total_lines: int) -> list[dict]:
    if not segments:
        return []
    segments.sort(key=lambda s: (s["line_start"], -s["line_end"]))
    merged: list[dict] = []
    covered_up_to = 0
    for seg in segments:
        if seg["line_start"] <= covered_up_to:
            if seg["line_end"] <= covered_up_to:
                continue
            seg = {**seg, "line_start": covered_up_to + 1}
        if seg["line_end"] < seg["line_start"]:
            continue
        if merged and merged[-1]["tag"] == seg["tag"] and seg["line_start"] <= merged[-1]["line_end"] + 2:
            merged[-1]["line_end"] = max(merged[-1]["line_end"], seg["line_end"])
            if seg["summary"] and not merged[-1]["summary"]:
                merged[-1]["summary"] = seg["summary"]
            merged[-1]["keywords"] = list(set(merged[-1]["keywords"] + seg["keywords"]))
        else:
            merged.append(seg)
        covered_up_to = max(covered_up_to, seg["line_end"])
    return merged
