"""Wiki Phase B — per-chapter LLM summarization.

For each chapter in `wiki_chapters` whose `summary_sha` doesn't match
the current canonical content sha, call the workspace's LLM provider
to produce a 1-3 sentence summary + keywords + entities. Skipped
chapters cost nothing.

See docs/processing-pipeline.md §4.2.

This module's public surface is `summarize_document` — the route
handler and the cron-triggered backfill both call it.

Uses the existing classifier's LLM call (sync httpx.Client) wrapped
in `asyncio.to_thread` so per-chapter parallelism stays bounded by
`max_concurrency` from the workspace's provider config (cap 4
chapters in flight per the doc).
"""

from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass
from uuid import UUID

from app.common.db import pool
from app.infra.canonical import canonical_sha, canonicalize
from app.services.enrich.classifier import ProviderConfig, _call_llm
from app.services.enrich.executors.cloud_pool import _load_provider
from app.services.kb.entity_graph import upsert_entities_for_segments

log = logging.getLogger(__name__)

# Per-doc cap on chapters in flight, matches the classifier's
# convention. Wiki abstracts are fewer + larger calls than note
# classification so we don't try to outscale the provider's tier.
MAX_PARALLEL_CHAPTERS = 4


@dataclass(frozen=True)
class ChapterSummary:
    chapter_id: UUID
    title: str
    summary: str
    keywords: list[str]
    entities: list[dict]      # [{name, type}]
    summary_sha: str          # sha of canonical chapter text we summarized


def _build_prompt(title: str, body: str, tags: list[str]) -> tuple[str, str]:
    """System + user prompt pair for one chapter abstract.

    Tags are passed so the LLM tags the entities consistently with the
    workspace's vocabulary; the chapter summary itself isn't bucketed
    by tag (a chapter typically belongs to one wiki topic anyway)."""
    tag_block = ", ".join(tags) if tags else "(none)"
    system = (
        "You summarize one section of a knowledge-base wiki for storage as "
        "an abstract sheet. Be precise, terse, and language-faithful: write "
        "your summary in the SAME language as the section text. "
        "Output ONLY a single valid JSON object — no surrounding prose, "
        "no markdown fences. The schema is:\n"
        '  { "summary": "1 to 3 sentences", '
        '"keywords": ["..."], '
        '"entities": [{"name": "...", "type": "concept|tool|person|product|...|other"}] }'
    )
    user = (
        f"Section title: {title}\n"
        f"Workspace tag vocabulary (for reference, NOT a constraint on summary): {tag_block}\n\n"
        f"Section text:\n{body.strip()}"
    )
    return system, user


def _parse_response(raw: str) -> dict:
    """LLM returns plain JSON; tolerate ``` fences and surrounding text."""
    if not raw:
        return {}
    s = raw.strip()
    if s.startswith("```"):
        # Strip ``` and an optional language tag on the first line.
        s = s.split("\n", 1)[1] if "\n" in s else s[3:]
        if s.endswith("```"):
            s = s[:-3]
        s = s.strip()
    try:
        parsed = json.loads(s)
        if not isinstance(parsed, dict):
            return {}
        return parsed
    except json.JSONDecodeError:
        log.warning("wiki Phase B response was not valid JSON: %r", raw[:200])
        return {}


async def summarize_document(workspace_id: str, document_id: str) -> dict:
    """Phase B for one wiki document. Reads chapters from
    wiki_chapters, summarizes the ones whose canonical-text-sha
    differs from their stored summary_sha, writes back summary +
    keywords + linked entities.

    Returns: { chapters: int, summarized: int, skipped: int,
               failed: int, prompt_tokens: int, completion_tokens: int }
    """
    cfg = await _load_provider(workspace_id)
    if cfg is None:
        return {
            "chapters": 0, "summarized": 0, "skipped": 0, "failed": 0,
            "prompt_tokens": 0, "completion_tokens": 0,
            "error": "no LLM provider configured",
        }

    ws = UUID(workspace_id)
    doc_uuid = UUID(document_id)

    async with pool().acquire() as conn:
        chapters = await conn.fetch(
            """
            SELECT id, ord, title, line_start, line_end, summary_sha
            FROM wiki_chapters
            WHERE document_id = $1
            ORDER BY ord
            """,
            doc_uuid,
        )
        # Pull each chapter's source text from the document. Cheaper
        # than denormalizing — chapter text is just a slice of the
        # document body.
        doc_row = await conn.fetchrow(
            "SELECT content FROM documents WHERE id=$1 AND workspace_id=$2",
            doc_uuid, ws,
        )
        if doc_row is None:
            return {"chapters": 0, "summarized": 0, "skipped": 0,
                    "failed": 0, "prompt_tokens": 0, "completion_tokens": 0,
                    "error": "document not found"}
        # Workspace tag vocabulary (informational; the LLM is told it
        # is NOT a constraint on summary text — see _build_prompt).
        tag_rows = await conn.fetch(
            "SELECT name FROM workspace_tags WHERE workspace_id = $1 "
            "ORDER BY sort_order, name",
            ws,
        )
    tags = [r["name"] for r in tag_rows]

    content_lines = (doc_row["content"] or "").replace("\r\n", "\n").replace("\r", "\n").split("\n")

    # Decide which chapters need work.
    work_items: list[tuple] = []  # (chapter_row, chapter_text, sha)
    skipped = 0
    for ch in chapters:
        body = "\n".join(content_lines[ch["line_start"] - 1: ch["line_end"]])
        sha = canonical_sha(body)
        if ch["summary_sha"] == sha and sha != "":
            skipped += 1
            continue
        work_items.append((ch, body, sha))

    if not work_items:
        return {
            "chapters": len(chapters), "summarized": 0, "skipped": skipped,
            "failed": 0, "prompt_tokens": 0, "completion_tokens": 0,
        }

    # ── Bounded-parallel LLM calls ──
    sem = asyncio.Semaphore(min(MAX_PARALLEL_CHAPTERS, cfg.max_concurrency))

    async def one(ch_row, body: str, sha: str) -> ChapterSummary | None:
        async with sem:
            system, user = _build_prompt(ch_row["title"], body, tags)
            # _call_llm is sync (httpx.Client). Push to thread pool
            # so parallelism is real, not blocked on the event loop.
            raw, _usage = await asyncio.to_thread(_call_llm, cfg, system, user)
        parsed = _parse_response(raw or "")
        if not parsed:
            return None
        return ChapterSummary(
            chapter_id=ch_row["id"],
            title=ch_row["title"],
            summary=str(parsed.get("summary") or "")[:2000],
            keywords=[str(k) for k in (parsed.get("keywords") or []) if k][:32],
            entities=[
                e for e in (parsed.get("entities") or [])
                if isinstance(e, dict) and e.get("name")
            ][:32],
            summary_sha=sha,
        )

    # Token bookkeeping for cost log (P0-* ledger lands in §10.2;
    # this hooks in once the run row is wired).
    prompt_tokens = completion_tokens = 0
    results = await asyncio.gather(*[one(*w) for w in work_items])

    summarized = failed = 0
    async with pool().acquire() as conn:
        async with conn.transaction():
            for cs in results:
                if cs is None:
                    failed += 1
                    continue
                await conn.execute(
                    """
                    UPDATE wiki_chapters
                       SET summary = $2,
                           keywords = $3::jsonb,
                           summary_sha = $4,
                           updated_at = now()
                     WHERE id = $1
                    """,
                    cs.chapter_id,
                    cs.summary,
                    json.dumps(cs.keywords, ensure_ascii=False),
                    cs.summary_sha,
                )
                # Treat the chapter as a "segment" for the existing
                # entity-link plumbing; tag is the chapter anchor so
                # the topology can attribute mentions back to the
                # chapter even after edits.
                if cs.entities:
                    await upsert_entities_for_segments(
                        conn, workspace_id,
                        [{"tag": f"wiki:{cs.title}", "entities": cs.entities}],
                        source_kind="wiki_chapter",
                    )
                summarized += 1

    return {
        "chapters": len(chapters),
        "summarized": summarized,
        "skipped": skipped,
        "failed": failed,
        "prompt_tokens": prompt_tokens,
        "completion_tokens": completion_tokens,
    }
