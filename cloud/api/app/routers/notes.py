"""Note tag classification — `note_classify` stage + accept/dismiss.

Architecture (v3.6):
  Wiki/doc kinds      → ai_enrich           writes tag_segments     (tags applied directly)
  Note kind           → note_classify        writes note_tag_suggestions (user reviews, accepts)

Endpoints:
  POST /v1/notes/{document_id}/classify
       → kicks off note_classify; returns run_id; suggestions land
         in note_tag_suggestions; client subscribes to ws for
         enrich_done with stage=note_classify

  GET  /v1/notes/{document_id}/suggestions
       → current pending suggestions for the user to review

  POST /v1/notes/{document_id}/suggestions/{tag}/accept
       → marks accepted; copies tag into the note's user_tags
         (document.metadata.user_tags[])

  POST /v1/notes/{document_id}/suggestions/{tag}/dismiss
       → marks dismissed; doesn't touch user_tags

The actual LLM call is delegated to the existing enrichment provider
pool (services.enrich.executors.cloud_pool). The wrapper here:
  1. constructs a closed-enum prompt from workspace_tags
  2. parses the LLM response → list[(tag, confidence)]
  3. validates each tag is in workspace_tags (drops unknown)
  4. inserts into note_tag_suggestions

For the v3.6 milestone this router exists with the table + endpoints
+ accept/dismiss working end-to-end against a stub classifier; the
real LLM glue lands together with the desktop NotesPane (#9).
"""

from __future__ import annotations

import logging
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel

import asyncio
from app.common.db import pool
from app.deps import Identity, require_scope
from app.services import processing_runs as runs_ledger
from app.services.realtime_protocol import broadcast, event_payload
from app.services.llm_cost import cost_usd as _cost_usd

log = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/notes", tags=["notes"])


# ─── Models ──────────────────────────────────────────────────────────


class Suggestion(BaseModel):
    tag: str
    confidence: float
    reasoning: str | None = None
    status: str = "pending"
    proposed_at: str
    reviewed_at: str | None = None


class SuggestionList(BaseModel):
    suggestions: list[Suggestion]


class ClassifyResponse(BaseModel):
    run_id: str
    status: str
    suggested_count: int


class AcceptResponse(BaseModel):
    tag: str
    user_tags: list[str]


# ─── Helpers ─────────────────────────────────────────────────────────


async def _load_workspace_tags(conn: Any, ws_uuid: UUID) -> list[str]:
    rows = await conn.fetch(
        "SELECT name FROM workspace_tags WHERE workspace_id=$1 ORDER BY sort_order",
        ws_uuid,
    )
    return [r["name"] for r in rows]


async def _document_for(conn: Any, ws_uuid: UUID, doc_uuid: UUID) -> dict[str, Any]:
    row = await conn.fetchrow(
        "SELECT id, name, content, metadata FROM documents WHERE id=$1 AND workspace_id=$2",
        doc_uuid,
        ws_uuid,
    )
    if not row:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "document not found")
    return dict(row)


# ─── Stub classifier ─────────────────────────────────────────────────
# Replaced by the real LLM call in #9. Kept here so the table +
# endpoints + accept/dismiss flow can be exercised end-to-end before
# the desktop side is built.


async def _classify_via_provider(
    workspace_id: str,
    content: str,
    vocab: list[str],
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Real LLM classification — closed-enum against `vocab`.

    Reuses the same provider pool as `runDocumentEnrich`
    (services.enrich.executors.cloud_pool). The classifier returns
    per-line-segment tag + confidence; we aggregate up to a per-tag
    max-confidence list and silently drop any tag the LLM hallucinated
    (the safety contract: AI never invents tags outside `vocab`).

    Returns: (suggestions, telemetry) where telemetry has
    {prompt_tokens, completion_tokens, total_tokens, model,
     cost_usd, max_concurrency}.

    Falls back to keyword stub if the provider isn't configured —
    so dev environments without an API key still see *something*
    sensible in the Notes Tags tab.
    """
    if not vocab or not content:
        return [], {}

    from app.services.enrich.executors.cloud_pool import _load_provider
    from app.services.enrich.classifier import run_classify

    cfg = await _load_provider(workspace_id)
    if cfg is None:
        # Stub fallback for dev-without-key. Marked in telemetry so
        # callers can show "(stub)" hint if they want to.
        return _stub_fallback(content, vocab), {"model": "stub", "stub": True}

    lines = content.splitlines() or [content]
    try:
        out = await asyncio.to_thread(
            run_classify, lines, cfg, vocab, cfg.max_concurrency,
        )
    except Exception as e:
        log.exception("note_classify provider call failed")
        # Better to fall back than to fail the request entirely;
        # the user can still author tags manually.
        return _stub_fallback(content, vocab), {"model": cfg.model, "error": str(e)}

    # Aggregate: per-tag max-confidence across segments.
    by_tag: dict[str, dict[str, Any]] = {}
    vocab_set = {t.lower() for t in vocab}
    for seg in out.segments:
        tag_raw = seg.get("tag")
        conf = float(seg.get("confidence", 0.0))
        if not isinstance(tag_raw, str):
            continue
        # Drop hallucinated tags — the dictionary is the contract.
        if tag_raw.lower() not in vocab_set:
            continue
        # Map back to canonical capitalization
        canon = next((t for t in vocab if t.lower() == tag_raw.lower()), tag_raw)
        prev = by_tag.get(canon)
        if prev is None or conf > prev["confidence"]:
            by_tag[canon] = {
                "tag": canon,
                "confidence": conf,
                "reasoning": str(seg.get("summary", "") or "")[:200] or None,
            }

    suggestions = sorted(by_tag.values(), key=lambda x: x["confidence"], reverse=True)[:8]

    # Cost
    cost = _cost_usd(model=cfg.model, input_tokens=out.prompt_tokens,
                     output_tokens=out.completion_tokens)
    telemetry = {
        "model": cfg.model,
        "prompt_tokens": out.prompt_tokens,
        "completion_tokens": out.completion_tokens,
        "total_tokens": out.total_tokens,
        "max_concurrency": cfg.max_concurrency,
        "cost_usd": cost,
    }
    return suggestions, telemetry


def _stub_fallback(content: str, vocab: list[str]) -> list[dict[str, Any]]:
    """Keyword-only fallback when no provider is configured. Used in
    dev environments and as a graceful degrade if the LLM call fails.
    The Tags tab gets *something* rather than nothing — clearly
    inferior to the real LLM, but enough to let UX testing proceed."""
    text = content.lower()
    out: list[dict[str, Any]] = []
    for tag in vocab:
        token = tag.lower().replace("-", " ")
        if token and token in text:
            count = text.count(token)
            conf = min(1.0, 0.4 + 0.15 * count)
            out.append({"tag": tag, "confidence": conf,
                        "reasoning": f"keyword fallback (×{count})"})
    out.sort(key=lambda x: x["confidence"], reverse=True)
    return out[:8]


# ─── Endpoints ───────────────────────────────────────────────────────


@router.post("/{document_id}/classify", response_model=ClassifyResponse)
async def classify_note(
    document_id: str,
    identity: Identity = Depends(require_scope("memories:write")),
) -> ClassifyResponse:
    """Run note_classify against this note. Returns run_id once the
    suggestions are landed. Re-running supersedes any pending
    suggestions for the same (doc, tag) — the unique partial index
    on note_tag_suggestions takes care of deduping."""
    try:
        doc_uuid = UUID(document_id)
        ws_uuid = UUID(identity.workspace_id)
    except ValueError:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "invalid uuid")

    p = pool()
    async with p.acquire() as conn:
        doc = await _document_for(conn, ws_uuid, doc_uuid)
        vocab = await _load_workspace_tags(conn, ws_uuid)

    run_id = await runs_ledger.start(
        workspace_id=str(ws_uuid),
        document_id=str(doc_uuid),
        kind="note_classify",
        revision=0,
        executor="cloud_pool",
        api_key_id=identity.api_key_id,
    )
    if run_id is None:
        # Dedup hit — return the last successful run id
        async with p.acquire() as conn:
            row = await conn.fetchrow(
                """
                SELECT id::text AS id FROM processing_runs
                WHERE workspace_id=$1 AND document_id=$2 AND kind='note_classify'
                ORDER BY created_at DESC LIMIT 1
                """,
                ws_uuid,
                doc_uuid,
            )
        return ClassifyResponse(
            run_id=row["id"] if row else "dedup",
            status="skipped_dedup",
            suggested_count=0,
        )

    # Emit running event so the panel + desktop see the start
    broadcast(
        str(ws_uuid),
        event_payload(
            event="note_classify_started",
            workspace_id=str(ws_uuid),
            document_id=str(doc_uuid),
            run_id=run_id,
            stage="note_classify",
            status="running",
        ),
    )

    try:
        suggestions, telemetry = await _classify_via_provider(
            str(ws_uuid), doc.get("content") or "", vocab,
        )
    except Exception as e:
        log.exception("note_classify failed for doc %s", doc_uuid)
        await runs_ledger.finish(run_id=run_id, status="failed", error=str(e))
        broadcast(
            str(ws_uuid),
            event_payload(
                event="note_classify_done",
                workspace_id=str(ws_uuid),
                document_id=str(doc_uuid),
                run_id=run_id,
                stage="note_classify",
                status="failed",
                error=str(e),
            ),
        )
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, str(e))

    # Land suggestions, replacing prior pending entries for any tag
    # that the new run scored. Upsert via the unique partial index.
    async with p.acquire() as conn:
        async with conn.transaction():
            for s in suggestions:
                await conn.execute(
                    """
                    INSERT INTO note_tag_suggestions
                      (workspace_id, document_id, run_id, tag, confidence, reasoning, status)
                    VALUES ($1, $2, $3, $4, $5, $6, 'pending')
                    ON CONFLICT (workspace_id, document_id, tag)
                    WHERE status = 'pending'
                    DO UPDATE SET
                      run_id     = EXCLUDED.run_id,
                      confidence = EXCLUDED.confidence,
                      reasoning  = EXCLUDED.reasoning,
                      proposed_at = now()
                    """,
                    ws_uuid,
                    doc_uuid,
                    UUID(run_id),
                    s["tag"],
                    s["confidence"],
                    s.get("reasoning"),
                )

    result_payload = {
        "suggested_count": len(suggestions),
        "dictionary_size": len(vocab),
        "mode": "user_dict_constrained",
        **telemetry,  # model, cost_usd, prompt_tokens, completion_tokens, max_concurrency
    }
    await runs_ledger.finish(
        run_id=run_id,
        status="done",
        result=result_payload,
    )

    broadcast(
        str(ws_uuid),
        {
            **event_payload(
                event="note_classify_done",
                workspace_id=str(ws_uuid),
                document_id=str(doc_uuid),
                run_id=run_id,
                stage="note_classify",
                status="done",
                progress_current=len(suggestions),
                progress_total=len(vocab),
                data={
                    "suggested_count": len(suggestions),
                    "dictionary_size": len(vocab),
                    "mode": "user_dict_constrained",
                    "executor": "cloud_pool",
                    "model": telemetry.get("model"),
                    "cost_usd": telemetry.get("cost_usd"),
                    "input_tokens": telemetry.get("prompt_tokens"),
                    "output_tokens": telemetry.get("completion_tokens"),
                },
            ),
            "suggested_count": len(suggestions),
        },
    )

    return ClassifyResponse(
        run_id=run_id,
        status="done",
        suggested_count=len(suggestions),
    )


@router.get("/{document_id}/suggestions", response_model=SuggestionList)
async def list_suggestions(
    document_id: str,
    identity: Identity = Depends(require_scope("read:memories")),
) -> SuggestionList:
    """Pending tag suggestions for this note. Accepted/dismissed land
    in the audit trail but don't show here."""
    try:
        doc_uuid = UUID(document_id)
        ws_uuid = UUID(identity.workspace_id)
    except ValueError:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "invalid uuid")

    p = pool()
    async with p.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT tag, confidence, reasoning, status, proposed_at, reviewed_at
            FROM note_tag_suggestions
            WHERE workspace_id=$1 AND document_id=$2 AND status='pending'
            ORDER BY confidence DESC
            """,
            ws_uuid,
            doc_uuid,
        )
    return SuggestionList(
        suggestions=[
            Suggestion(
                tag=r["tag"],
                confidence=float(r["confidence"]),
                reasoning=r["reasoning"],
                status=r["status"],
                proposed_at=r["proposed_at"].isoformat(),
                reviewed_at=r["reviewed_at"].isoformat() if r["reviewed_at"] else None,
            )
            for r in rows
        ]
    )


@router.post("/{document_id}/suggestions/{tag}/accept", response_model=AcceptResponse)
async def accept_suggestion(
    document_id: str,
    tag: str,
    identity: Identity = Depends(require_scope("memories:write")),
) -> AcceptResponse:
    """Accept a suggestion: mark as accepted + add tag to the note's
    user_tags in document.metadata. Idempotent — accepting again is
    a no-op."""
    try:
        doc_uuid = UUID(document_id)
        ws_uuid = UUID(identity.workspace_id)
    except ValueError:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "invalid uuid")

    p = pool()
    async with p.acquire() as conn:
        async with conn.transaction():
            row = await conn.fetchrow(
                "SELECT metadata FROM documents WHERE id=$1 AND workspace_id=$2 FOR UPDATE",
                doc_uuid,
                ws_uuid,
            )
            if not row:
                raise HTTPException(status.HTTP_404_NOT_FOUND, "document not found")
            meta = row["metadata"] or {}
            if not isinstance(meta, dict):
                meta = {}
            user_tags = list(meta.get("user_tags") or [])
            if tag not in user_tags:
                user_tags.append(tag)
                meta["user_tags"] = user_tags
                await conn.execute(
                    "UPDATE documents SET metadata=$1::jsonb, updated_at=now() WHERE id=$2",
                    meta,
                    doc_uuid,
                )
            await conn.execute(
                """
                UPDATE note_tag_suggestions
                SET status='accepted', reviewed_at=now()
                WHERE workspace_id=$1 AND document_id=$2 AND tag=$3 AND status='pending'
                """,
                ws_uuid,
                doc_uuid,
                tag,
            )
    return AcceptResponse(tag=tag, user_tags=user_tags)


@router.post("/{document_id}/suggestions/{tag}/dismiss")
async def dismiss_suggestion(
    document_id: str,
    tag: str,
    identity: Identity = Depends(require_scope("memories:write")),
) -> dict[str, Any]:
    """Dismiss a suggestion: mark as dismissed. user_tags untouched."""
    try:
        doc_uuid = UUID(document_id)
        ws_uuid = UUID(identity.workspace_id)
    except ValueError:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "invalid uuid")
    p = pool()
    async with p.acquire() as conn:
        await conn.execute(
            """
            UPDATE note_tag_suggestions
            SET status='dismissed', reviewed_at=now()
            WHERE workspace_id=$1 AND document_id=$2 AND tag=$3 AND status='pending'
            """,
            ws_uuid,
            doc_uuid,
            tag,
        )
    return {"tag": tag, "dismissed": True}


@router.post("/{document_id}/user_tags")
async def add_user_tag(
    document_id: str,
    body: dict[str, Any],
    identity: Identity = Depends(require_scope("memories:write")),
) -> AcceptResponse:
    """Manually add a tag to the note's user_tags — bypasses the AI
    suggestion flow (the user types it directly in the editor).

    Body: {"tag": "design"}
    """
    tag = (body or {}).get("tag")
    if not tag or not isinstance(tag, str):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "missing tag")
    return await accept_suggestion(document_id, tag, identity)
