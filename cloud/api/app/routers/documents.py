"""Documents + simple synchronous ingest.

MVP ingest = chunk document by paragraph, embed each chunk, store each as
a `document_ref` memory linking back to the document. Keeps the shape of
the full pipeline (document → chunks → retrievable memories) without
bringing over the OSS repo's pack/enrich machinery yet. v1.1 adds
async jobs + richer chunking.
"""

from __future__ import annotations

from datetime import datetime
from uuid import UUID

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from app import usage
from app.db import pool
from app.deps import Identity, require_scope


# Ingest the document in the background. Failures don't bubble up — the
# caller already has the saved document; auto-ingest is best-effort.
# Notes + wiki_topic get chunks; smart_table / skill are JSON-shaped
# and don't make sense to chunk.
_AUTO_INGEST_KINDS = {"note", "wiki_topic"}


def _schedule_auto_ingest(
    bg: BackgroundTasks, workspace_id: str, doc_id: str, metadata: dict | None,
) -> None:
    """Schedule chunk + embed for the doc as a background task.

    Dispatches BY KIND via the knowledge wiring helper so:
      - smartnote_type='note'       → pipeline.ingest_document
      - smartnote_type='wiki_topic' → wiki_processor.process_wiki_document
                                      (the only path that fills
                                      wiki_chapters; without it,
                                      "Build wiki abstract" sees
                                      0/0 chapters)
    Also opens a processing_runs row + broadcasts chunk_embed_done
    so the desktop's KP page and Library KN view see auto-ingest
    activity in real time.
    """
    md = metadata or {}
    snt = md.get("smartnote_type") if isinstance(md, dict) else None
    if snt not in _AUTO_INGEST_KINDS:
        return
    from app.contexts.knowledge.wiring import _record_and_run

    async def _runner():
        try:
            await _record_and_run(workspace_id, doc_id, snt)
        except Exception:
            import logging
            logging.getLogger(__name__).warning(
                "auto-ingest failed for %s/%s (kind=%s)",
                workspace_id, doc_id, snt, exc_info=True,
            )

    bg.add_task(_runner)

router = APIRouter(prefix="/v1/documents", tags=["documents"])


class DocumentCreate(BaseModel):
    name: str
    content: str
    kind: str = "text"
    metadata: dict | None = None


class DocumentPatch(BaseModel):
    # Partial update for sync callers. Changing `content` clears
    # `ingested_at` so the caller can decide whether to re-run ingest.
    name: str | None = None
    content: str | None = None
    kind: str | None = None
    metadata: dict | None = None


class DocumentOut(BaseModel):
    id: str
    workspace_id: str
    name: str
    kind: str
    byte_size: int
    ingested_at: str | None = None
    created_at: str
    updated_at: str | None = None
    metadata: dict | None = None


def _row_to_out(r) -> DocumentOut:
    # asyncpg Records expose keys() but not dict.get(); normalize first.
    d = dict(r)
    return DocumentOut(
        id=str(d["id"]),
        workspace_id=str(d["workspace_id"]),
        name=d["name"],
        kind=d["kind"],
        byte_size=d["byte_size"],
        ingested_at=d["ingested_at"].isoformat() if d.get("ingested_at") else None,
        created_at=d["created_at"].isoformat(),
        updated_at=d["updated_at"].isoformat() if d.get("updated_at") else None,
        metadata=d.get("metadata"),
    )


@router.post(
    "",
    response_model=DocumentOut,
    dependencies=[Depends(require_scope("documents:write"))],
)
async def create_document(
    req: DocumentCreate,
    background_tasks: BackgroundTasks,
    identity: Identity = Depends(require_scope("documents:write")),
) -> DocumentOut:
    byte_size = len(req.content.encode("utf-8"))
    async with pool().acquire() as conn:
        row = await conn.fetchrow(
            "INSERT INTO documents(workspace_id, name, kind, content, "
            "  metadata, byte_size) "
            "VALUES($1, $2, $3, $4, $5, $6) "
            "RETURNING id, workspace_id, name, kind, byte_size, ingested_at, "
            "          created_at, updated_at, metadata",
            UUID(identity.workspace_id),
            req.name,
            req.kind,
            req.content,
            req.metadata or {},
            byte_size,
        )
    # Auto-ingest after the doc lands so a sync push from device A
    # makes the chunks immediately available to device B's search.
    _schedule_auto_ingest(
        background_tasks, identity.workspace_id, str(row["id"]), req.metadata,
    )
    await usage.bump(identity.workspace_id, document_delta=1)
    return _row_to_out(row)


# Legacy POST /v1/documents/{id}/ingest endpoint retired.
# Wrote chunks into memories(kind='document_ref') instead of the
# canonical chunks/wiki_chapters tables — every consumer migrated
# off it years ago. The current ingest surface is:
#   POST /v1/ingest/document       — single-doc ingest (kind-aware)
#   POST /v1/processing/{id}/run   — full canonical run with ledger
# Removing the route doesn't break clients: cloudApi.ingestDocument
# in the desktop already targets /v1/ingest/document, and the
# Python SDK was updated to match.


@router.get("", dependencies=[Depends(require_scope("documents:read"))])
async def list_documents(
    identity: Identity = Depends(require_scope("documents:read")),
    since: str | None = Query(default=None, description="ISO timestamp; return docs updated after this"),
    smartnote_type: str | None = Query(default=None, description="metadata.smartnote_type filter (note|wiki_topic|smart_table)"),
) -> dict:
    where = ["workspace_id = $1"]
    args: list = [UUID(identity.workspace_id)]
    if since:
        # asyncpg wants a datetime, not an ISO string. Python 3.11+
        # handles trailing 'Z' but older stacks don't — normalize.
        try:
            args.append(datetime.fromisoformat(since.replace("Z", "+00:00")))
        except ValueError:
            raise HTTPException(400, f"invalid 'since' timestamp: {since!r}")
        where.append(f"updated_at > ${len(args)}")
    if smartnote_type:
        args.append(smartnote_type)
        where.append(f"metadata->>'smartnote_type' = ${len(args)}")
    sql = (
        "SELECT id, workspace_id, name, kind, byte_size, ingested_at, "
        "       created_at, updated_at, metadata "
        "FROM documents WHERE " + " AND ".join(where) +
        " ORDER BY updated_at DESC"
    )
    async with pool().acquire() as conn:
        rows = await conn.fetch(sql, *args)
    return {"documents": [_row_to_out(r).model_dump() for r in rows]}


@router.patch(
    "/{document_id}",
    response_model=DocumentOut,
    dependencies=[Depends(require_scope("documents:write"))],
)
async def patch_document(
    document_id: str,
    req: DocumentPatch,
    background_tasks: BackgroundTasks,
    identity: Identity = Depends(require_scope("documents:write")),
) -> DocumentOut:
    updates = req.model_dump(exclude_unset=True)
    if not updates:
        raise HTTPException(400, "nothing to update")
    sets = ["updated_at = now()"]
    args: list = []
    if "name" in updates:
        args.append(updates["name"]); sets.append(f"name = ${len(args)}")
    if "kind" in updates:
        args.append(updates["kind"]); sets.append(f"kind = ${len(args)}")
    if "metadata" in updates:
        args.append(updates["metadata"] or {}); sets.append(f"metadata = ${len(args)}")
    if "content" in updates and updates["content"] is not None:
        content = updates["content"]
        args.append(content); sets.append(f"content = ${len(args)}")
        args.append(len(content.encode("utf-8"))); sets.append(f"byte_size = ${len(args)}")
        # Clear ingest timestamp — chunks from the old content no longer
        # reflect the doc; caller should re-ingest (or leave it stale).
        sets.append("ingested_at = NULL")
    args.append(UUID(document_id))
    doc_pos = len(args)
    args.append(UUID(identity.workspace_id))
    ws_pos = len(args)

    sql = (
        "UPDATE documents SET " + ", ".join(sets) +
        f" WHERE id = ${doc_pos} AND workspace_id = ${ws_pos} "
        "RETURNING id, workspace_id, name, kind, byte_size, ingested_at, "
        "          created_at, updated_at, metadata"
    )
    async with pool().acquire() as conn:
        row = await conn.fetchrow(sql, *args)
    if not row:
        raise HTTPException(404, "document not found")
    # Re-ingest only when the actual text changed; pure metadata
    # patches (renames, scope tweaks) don't need it.
    if "content" in updates and updates["content"] is not None:
        _schedule_auto_ingest(
            background_tasks, identity.workspace_id, str(row["id"]),
            row.get("metadata"),
        )
    return _row_to_out(row)


@router.delete(
    "/{document_id}",
    dependencies=[Depends(require_scope("documents:write"))],
)
async def delete_document(
    document_id: str,
    identity: Identity = Depends(require_scope("documents:write")),
) -> dict:
    async with pool().acquire() as conn:
        # Also delete document_ref memories tied to this document so the
        # workspace doesn't accumulate orphan chunks from past versions.
        async with conn.transaction():
            await conn.execute(
                "DELETE FROM memories WHERE workspace_id = $1 "
                "AND kind = 'document_ref' AND structured->>'document_id' = $2",
                UUID(identity.workspace_id), document_id,
            )
            result = await conn.execute(
                "DELETE FROM documents WHERE id = $1 AND workspace_id = $2",
                UUID(document_id), UUID(identity.workspace_id),
            )
    if not result.endswith(" 1"):
        raise HTTPException(404, "document not found")
    return {"deleted": True, "id": document_id}


@router.get("/{document_id}", dependencies=[Depends(require_scope("documents:read"))])
async def get_document(
    document_id: str,
    identity: Identity = Depends(require_scope("documents:read")),
) -> dict:
    async with pool().acquire() as conn:
        row = await conn.fetchrow(
            "SELECT id, workspace_id, name, kind, content, metadata, byte_size, "
            "       ingested_at, created_at "
            "FROM documents WHERE id = $1 AND workspace_id = $2",
            UUID(document_id), UUID(identity.workspace_id),
        )
    if not row:
        raise HTTPException(404, "document not found")
    return {
        **_row_to_out(row).model_dump(),
        "content": row["content"],
        "metadata": row["metadata"],
    }


@router.get("/{document_id}/kn", dependencies=[Depends(require_scope("documents:read"))])
async def get_document_kn(
    document_id: str,
    identity: Identity = Depends(require_scope("documents:read")),
) -> dict:
    """Knowledge view of a document — what's been computed for it:
    chunks (chunk + embed pass), tag_segments (LLM enrich pass),
    wiki_chapters (Phase B), processing_runs (canonical run ledger).
    One round-trip for the desktop's Library KN tab so it can render
    the actual processed state instead of placeholders.
    """
    ws = UUID(identity.workspace_id)
    doc = UUID(document_id)
    async with pool().acquire() as conn:
        # Confirm doc belongs to this workspace + read kind so we can
        # decide which downstream tables to consult (wiki_chapters for
        # wiki_topic, tag_segments for everything else).
        meta_row = await conn.fetchrow(
            "SELECT metadata FROM documents WHERE id=$1 AND workspace_id=$2",
            doc, ws,
        )
        if not meta_row:
            raise HTTPException(404, "document not found")
        import json as _json
        meta = meta_row["metadata"] or {}
        if isinstance(meta, str):
            try:
                meta = _json.loads(meta)
            except Exception:
                meta = {}
        kind = (meta.get("smartnote_type") or "")
        chunks = await conn.fetch(
            "SELECT id, dimension, line_start, line_end, text, keywords, "
            "       source_ref, (embedding IS NOT NULL) AS embedded "
            "FROM chunks WHERE document_id=$1 AND workspace_id=$2 "
            "ORDER BY line_start ASC LIMIT 200",
            doc, ws,
        )
        # Total + embedded counts (separate from the LIMIT 200 fetch
        # above). The E badge needs total truth, not the bounded
        # preview. A chunk row can exist with NULL embedding if the
        # embed pod was unavailable mid-ingest — surface that gap.
        chunk_counts = await conn.fetchrow(
            "SELECT count(*) AS total, "
            "       count(*) FILTER (WHERE embedding IS NOT NULL) AS embedded "
            "FROM chunks WHERE document_id=$1 AND workspace_id=$2",
            doc, ws,
        )
        # Wiki docs don't write tag_segments (chapter summary replaces
        # line-range tags); skip the query so we don't show stale rows
        # from a pre-fix run either.
        if kind == "wiki_topic":
            tag_segs = []
            wiki_chapters = await conn.fetch(
                "SELECT id, ord, level, anchor, title, line_start, line_end, "
                "       summary, keywords, summary_sha, last_error, updated_at "
                "FROM wiki_chapters WHERE document_id=$1 "
                "ORDER BY ord ASC",
                doc,
            )
        else:
            tag_segs = await conn.fetch(
                "SELECT id, start_line, end_line, tag, confidence, summary, meta "
                "FROM tag_segments WHERE document_id=$1 AND workspace_id=$2 "
                "ORDER BY start_line ASC LIMIT 200",
                doc, ws,
            )
            wiki_chapters = []
        # processing_runs is the canonical run ledger as of commit
        # 4def060 — UI consumers read from here. enrich_jobs was
        # dropped entirely in migration 026; processing_runs is now
        # the only run surface.
        runs = await conn.fetch(
            "SELECT id, kind, status, executor, error, revision, "
            "       created_at, started_at, finished_at, result "
            "FROM processing_runs WHERE document_id=$1 "
            "ORDER BY created_at DESC LIMIT 20",
            doc,
        )
        # G-badge truth: count entities attributed to this document via
        # tag_entities. tag_entities is workspace-scoped (the entity row
        # may have come from another doc sharing the same tag), so this
        # is "this doc's tags have N graph entities behind them" rather
        # than strict per-doc isolation. Good enough for the badge — if
        # the doc never produced segments/chapters, the resulting tag
        # set is empty and entity_count is 0.
        if kind == "wiki_topic":
            entity_count = await conn.fetchval(
                """
                SELECT count(DISTINCT te.entity_id)
                FROM tag_entities te
                WHERE te.workspace_id = $1
                  AND te.tag = ANY($2::text[])
                """,
                ws,
                [f"wiki:{ch['title']}" for ch in wiki_chapters] or [""],
            ) or 0
        else:
            entity_count = await conn.fetchval(
                """
                SELECT count(DISTINCT te.entity_id)
                FROM tag_entities te
                WHERE te.workspace_id = $1
                  AND te.tag IN (
                    SELECT DISTINCT tag FROM tag_segments
                    WHERE document_id = $2 AND workspace_id = $1
                  )
                """,
                ws, doc,
            ) or 0
    return {
        "document_id": str(doc),
        "kind": kind or "doc",
        "entity_count": int(entity_count),
        "chunk_total": int((chunk_counts and chunk_counts["total"]) or 0),
        "embedded_chunk_count": int((chunk_counts and chunk_counts["embedded"]) or 0),
        "wiki_chapters": [
            {
                "id": str(ch["id"]),
                "ord": int(ch["ord"]),
                "level": int(ch["level"]),
                "anchor": ch["anchor"],
                "title": ch["title"],
                "line_start": int(ch["line_start"]),
                "line_end": int(ch["line_end"]),
                "summary": ch["summary"] or "",
                "keywords": (
                    list(ch["keywords"]) if isinstance(ch["keywords"], list)
                    else (_json.loads(ch["keywords"]) if ch["keywords"] else [])
                ),
                "summarized": bool(ch["summary_sha"]),
                "last_error": ch["last_error"] or None,
                "updated_at": ch["updated_at"].isoformat() if ch["updated_at"] else None,
            } for ch in wiki_chapters
        ],
        "chunks": [
            {
                "id": str(c["id"]),
                "dimension": c["dimension"],
                "line_start": int(c["line_start"]),
                "line_end": int(c["line_end"]),
                "text": c["text"],
                "keywords": list(c["keywords"]) if c["keywords"] else [],
                "source_ref": c["source_ref"],
            } for c in chunks
        ],
        "tag_segments": [
            {
                "id": str(t["id"]),
                "line_start": int(t["start_line"]),
                "line_end": int(t["end_line"]),
                "tag": t["tag"],
                "confidence": float(t["confidence"] or 0),
                "summary": t["summary"] or "",
                "meta": (t["meta"] if isinstance(t["meta"], dict) else (
                    _json.loads(t["meta"]) if t["meta"] else {}
                )),
            } for t in tag_segs
        ],
        "processing_runs": [
            {
                "id": str(r["id"]),
                "kind": r["kind"],
                "status": r["status"],
                "executor": r["executor"],
                "error": r["error"],
                "revision": int(r["revision"] or 0),
                "created_at": r["created_at"].isoformat() if r["created_at"] else None,
                "started_at": r["started_at"].isoformat() if r["started_at"] else None,
                "finished_at": r["finished_at"].isoformat() if r["finished_at"] else None,
                "result": r["result"] if isinstance(r["result"], dict) else (
                    _json.loads(r["result"]) if r["result"] else None
                ),
            } for r in runs
        ],
    }


