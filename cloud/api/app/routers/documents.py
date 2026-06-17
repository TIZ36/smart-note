"""Documents + simple synchronous ingest."""

from __future__ import annotations

import json as _json
import re
from datetime import datetime, timezone
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from app import usage
from app.contexts.storage.events import (
    DocumentContentChanged,
    DocumentCreated,
    DocumentDeleted,
)
from app.db import pool
from app.deps import Identity, require_scope
from app.embeddings import embed_texts, format_vector_literal
from app.infra import events
from app.services.realtime_protocol import broadcast, event_payload


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


def _json_value(value, default=None):
    if value is None:
        return default
    if isinstance(value, (dict, list)):
        return value
    if isinstance(value, str):
        try:
            return _json.loads(value)
        except Exception:
            return default
    return value


def _domains_from_metadata(md) -> list[str]:
    """Knowledge-domain tags a document is filed under.

    Stored in metadata.domains (list, preferred) or metadata.domain (single).
    These tags get stamped onto the document's chunks so a domain-scoped
    retrieve (`/v1/retrieve` with tags=[domain]) reaches the book/note content.
    """
    if isinstance(md, str):
        try:
            md = _json.loads(md)
        except Exception:
            md = {}
    md = md or {}
    raw = md.get("domains")
    if isinstance(raw, list):
        return [str(t).strip() for t in raw if str(t).strip()]
    if md.get("domain"):
        return [str(md["domain"]).strip()]
    return []


def _content_stamp(identity: Identity) -> dict:
    return {
        "cloud_content_updated_at_ms": int(
            datetime.now(timezone.utc).timestamp() * 1000
        ),
        "cloud_content_updated_by": identity.agent_id or identity.api_key_id or "api",
    }


@router.post(
    "",
    response_model=DocumentOut,
    dependencies=[Depends(require_scope("documents:write"))],
)
async def create_document(
    req: DocumentCreate,
    identity: Identity = Depends(require_scope("documents:write")),
) -> DocumentOut:
    byte_size = len(req.content.encode("utf-8"))
    metadata = {**(_json_value(req.metadata, {}) or {}), **_content_stamp(identity)}
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
            metadata,
            byte_size,
        )
    await events.publish(
        DocumentCreated(
            workspace_id=identity.workspace_id,
            document_id=str(row["id"]),
            smartnote_type=metadata.get("smartnote_type"),
        )
    )
    await usage.bump(identity.workspace_id, document_delta=1)
    return _row_to_out(row)


@router.post(
    "/{document_id}/ingest",
    dependencies=[Depends(require_scope("documents:ingest"))],
)
async def ingest_document(
    document_id: str,
    identity: Identity = Depends(require_scope("documents:ingest")),
) -> dict:
    """Chunk the document, embed each chunk, land each as a memory.

    Synchronous at MVP — the embed service runs locally and a few dozen
    chunks completes in seconds. If we see documents that regularly chunk
    into 100+ pieces, move this behind a job queue (v1.1).
    """
    async with pool().acquire() as conn:
        doc = await conn.fetchrow(
            "SELECT id, name, content, workspace_id, metadata FROM documents "
            "WHERE id = $1 AND workspace_id = $2",
            UUID(document_id),
            UUID(identity.workspace_id),
        )
    if not doc:
        raise HTTPException(404, "document not found")

    chunks = _chunk_text(doc["content"])
    if not chunks:
        return {"ok": True, "chunks": 0}

    # Chunks inherit the document's knowledge-domain tags so a domain-scoped
    # retrieve reaches this content, not just hand-written memories.
    domain_tags = _domains_from_metadata(doc["metadata"])

    vectors = await embed_texts(chunks)

    async with pool().acquire() as conn:
        async with conn.transaction():
            for chunk_text, vec in zip(chunks, vectors):
                vec_literal = format_vector_literal(vec) if vec is not None else None
                await conn.execute(
                    """
                    INSERT INTO memories(
                      workspace_id, author_agent, kind, scope, content,
                      structured, embedding, source_refs, tags
                    ) VALUES (
                      $1, $2, 'document_ref', 'global', $3, $4, $5::vector, $6, $7
                    )
                    """,
                    UUID(identity.workspace_id),
                    identity.agent_id or "ingest",
                    chunk_text,
                    {"document_id": str(doc["id"]), "document_name": doc["name"]},
                    vec_literal,
                    [{"document_id": str(doc["id"])}],
                    domain_tags,
                )
            await conn.execute(
                "UPDATE documents SET ingested_at = now() WHERE id = $1",
                UUID(document_id),
            )
    await usage.bump(
        identity.workspace_id,
        memory_delta=len(chunks),
        embed_tokens=sum(len(c.split()) for c in chunks),
    )
    return {"ok": True, "chunks": len(chunks)}


@router.get("", dependencies=[Depends(require_scope("documents:read"))])
async def list_documents(
    identity: Identity = Depends(require_scope("documents:read")),
    since: str | None = Query(
        default=None, description="ISO timestamp; return docs updated after this"
    ),
    smartnote_type: str | None = Query(
        default=None,
        description="metadata.smartnote_type filter (note|wiki_topic|smart_table)",
    ),
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
        "FROM documents WHERE " + " AND ".join(where) + " ORDER BY updated_at DESC"
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
    identity: Identity = Depends(require_scope("documents:write")),
) -> DocumentOut:
    updates = req.model_dump(exclude_unset=True)
    if not updates:
        raise HTTPException(400, "nothing to update")
    sets = ["updated_at = now()"]
    args: list = []
    if "name" in updates:
        args.append(updates["name"])
        sets.append(f"name = ${len(args)}")
    if "kind" in updates:
        args.append(updates["kind"])
        sets.append(f"kind = ${len(args)}")
    if "metadata" in updates:
        metadata_patch = updates["metadata"] or {}
        if "content" in updates and updates["content"] is not None:
            metadata_patch = {**metadata_patch, **_content_stamp(identity)}
        args.append(metadata_patch)
        sets.append(f"metadata = ${len(args)}")
    if "content" in updates and updates["content"] is not None:
        content = updates["content"]
        if "metadata" not in updates:
            args.append(_content_stamp(identity))
            sets.append(f"metadata = metadata || ${len(args)}::jsonb")
        args.append(content)
        sets.append(f"content = ${len(args)}")
        args.append(len(content.encode("utf-8")))
        sets.append(f"byte_size = ${len(args)}")
        # Clear ingest timestamp — chunks from the old content no longer
        # reflect the doc; caller should re-ingest (or leave it stale).
        sets.append("ingested_at = NULL")
    args.append(UUID(document_id))
    doc_pos = len(args)
    args.append(UUID(identity.workspace_id))
    ws_pos = len(args)

    sql = (
        "UPDATE documents SET "
        + ", ".join(sets)
        + f" WHERE id = ${doc_pos} AND workspace_id = ${ws_pos} "
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
        metadata = _json_value(row["metadata"], {}) or {}
        await events.publish(
            DocumentContentChanged(
                workspace_id=identity.workspace_id,
                document_id=str(row["id"]),
                smartnote_type=metadata.get("smartnote_type"),
            )
        )
        broadcast(
            identity.workspace_id,
            event_payload(
                event="document_content_changed",
                workspace_id=identity.workspace_id,
                document_id=str(row["id"]),
                status="done",
                message="Document content changed in cloud",
                data={
                    "name": row["name"],
                    "metadata": metadata,
                    "updated_at": row["updated_at"].isoformat()
                    if row["updated_at"]
                    else None,
                    "cloud_content_updated_at_ms": metadata.get(
                        "cloud_content_updated_at_ms"
                    ),
                },
            ),
        )

    # Knowledge domains can be (re)assigned on an existing document by patching
    # metadata.domains. Re-tag its already-ingested chunks in place so the new
    # domain takes effect for `@域` retrieval immediately — no re-embed needed.
    # (No-op for documents that were never ingested: they have no chunks yet.)
    if "metadata" in updates:
        new_domains = _domains_from_metadata(row["metadata"])
        async with pool().acquire() as conn:
            await conn.execute(
                "UPDATE memories SET tags = $1, updated_at = now() "
                "WHERE workspace_id = $2 AND kind = 'document_ref' "
                "AND structured->>'document_id' = $3",
                new_domains,
                UUID(identity.workspace_id),
                str(row["id"]),
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
                UUID(identity.workspace_id),
                document_id,
            )
            result = await conn.execute(
                "DELETE FROM documents WHERE id = $1 AND workspace_id = $2",
                UUID(document_id),
                UUID(identity.workspace_id),
            )
    if not result.endswith(" 1"):
        raise HTTPException(404, "document not found")
    await events.publish(
        DocumentDeleted(workspace_id=identity.workspace_id, document_id=document_id)
    )
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
            UUID(document_id),
            UUID(identity.workspace_id),
        )
    if not row:
        raise HTTPException(404, "document not found")
    return {
        **_row_to_out(row).model_dump(),
        "content": row["content"],
        "metadata": row["metadata"],
    }


@router.get(
    "/{document_id}/kn", dependencies=[Depends(require_scope("documents:read"))]
)
async def get_document_kn(
    document_id: str,
    identity: Identity = Depends(require_scope("documents:read")),
) -> dict:
    """Canonical Library knowledge read model for one document."""
    ws = UUID(identity.workspace_id)
    doc = UUID(document_id)
    async with pool().acquire() as conn:
        # Confirm doc belongs to this workspace + read kind so we can
        # decide which downstream tables to consult (wiki_chapters for
        # wiki_topic, tag_segments for everything else).
        meta_row = await conn.fetchrow(
            "SELECT metadata, content_sha256 FROM documents WHERE id=$1 AND workspace_id=$2",
            doc,
            ws,
        )
        if not meta_row:
            raise HTTPException(404, "document not found")
        meta = _json_value(meta_row["metadata"], {}) or {}
        kind = meta.get("smartnote_type") or ""
        content_sha = meta_row["content_sha256"]
        counts = await conn.fetchrow(
            """
            SELECT
              count(*)::int AS chunk_total,
              count(*) FILTER (WHERE embedding IS NOT NULL)::int AS embedded_chunk_count
            FROM chunks
            WHERE document_id=$1 AND workspace_id=$2
            """,
            doc,
            ws,
        )
        entity_count = await conn.fetchval(
            """
            SELECT count(DISTINCT te.entity_id)::int
            FROM tag_entities te
            WHERE te.workspace_id=$1
              AND te.tag IN (
                SELECT DISTINCT dimension
                FROM chunks
                WHERE document_id=$2 AND workspace_id=$1
              )
            """,
            ws,
            doc,
        )
        # Larger cap so big wiki docs (e.g. ~500 chapter chunks) round-
        # trip in one /kn call. The full chunks list is needed for the
        # KN tab body + tree-row counts; capping at 200 hid the rest
        # of a 467-chunk doc and left the tab label disagreeing with
        # the row's chunk_total. 2000 ≈ 1MB over the wire — bounded
        # and well within JSON sanity. If we ever need more, add
        # cursor pagination instead of nudging the cap higher.
        chunks = await conn.fetch(
            "SELECT id, dimension, line_start, line_end, text, keywords, "
            "       source_ref "
            "FROM chunks WHERE document_id=$1 AND workspace_id=$2 "
            "ORDER BY line_start ASC LIMIT 2000",
            doc,
            ws,
        )
        # Wiki docs don't write tag_segments (chapter summary replaces
        # line-range tags); skip the query so we don't show stale rows
        # from a pre-fix run either.
        if kind == "wiki_topic":
            tag_segs = []
            wiki_chapters = await conn.fetch(
                "SELECT id, ord, level, anchor, title, line_start, line_end, "
                "       summary, keywords, summary_sha, updated_at "
                "FROM wiki_chapters WHERE document_id=$1 "
                "ORDER BY ord ASC",
                doc,
            )
        else:
            tag_segs = await conn.fetch(
                "SELECT id, start_line, end_line, tag, confidence, summary, meta "
                "FROM tag_segments WHERE document_id=$1 AND workspace_id=$2 "
                "ORDER BY start_line ASC LIMIT 200",
                doc,
                ws,
            )
            wiki_chapters = []
        runs = await conn.fetch(
            """
            SELECT id, kind, status, executor, error, revision, attempts,
                   created_at, started_at, finished_at, result, input_snapshot
            FROM processing_runs
            WHERE document_id=$1 AND workspace_id=$2
            ORDER BY created_at DESC LIMIT 20
            """,
            doc,
            ws,
        )
        suggestions = await conn.fetch(
            """
            SELECT id, run_id, tag, confidence, reasoning, status, proposed_at, reviewed_at
            FROM note_tag_suggestions
            WHERE document_id=$1 AND workspace_id=$2
            ORDER BY proposed_at DESC LIMIT 50
            """,
            doc,
            ws,
        )
        links = await conn.fetch(
            """
            SELECT dl.target_document_id, d.name AS target_name, dl.relation_type,
                   dl.score, dl.evidence, dl.run_id, dl.created_at
            FROM document_links dl
            JOIN documents d ON d.id=dl.target_document_id
            WHERE dl.source_document_id=$1 AND dl.workspace_id=$2
            ORDER BY dl.score DESC, dl.created_at DESC LIMIT 50
            """,
            doc,
            ws,
        )
    processing_runs = [
        {
            "id": str(r["id"]),
            "run_id": str(r["id"]),
            "kind": r["kind"],
            "status": r["status"],
            "executor": r["executor"],
            "error": _json_value(r["error"], r["error"]),
            "revision": int(r["revision"] or 0),
            "attempts": int(r["attempts"] or 0),
            "created_at": r["created_at"].isoformat() if r["created_at"] else None,
            "started_at": r["started_at"].isoformat() if r["started_at"] else None,
            "finished_at": r["finished_at"].isoformat() if r["finished_at"] else None,
            "result": _json_value(r["result"], None),
            "input_snapshot": _json_value(r["input_snapshot"], {}),
        }
        for r in runs
    ]
    latest_by_kind = {}
    for run in processing_runs:
        latest_by_kind.setdefault(run["kind"], run)

    def stage_state(stage: str, available: bool = True) -> dict:
        latest = latest_by_kind.get(stage)
        snap = latest.get("input_snapshot", {}) if latest else {}
        stale = bool(latest and content_sha and snap.get("content_sha") != content_sha)
        return {
            "stage": stage,
            "available": available,
            "status": latest["status"]
            if latest
            else ("idle" if available else "unavailable"),
            "run_id": latest["run_id"] if latest else None,
            "revision": latest["revision"] if latest else 0,
            "stale": stale,
            "error": latest.get("error") if latest else None,
            "result": latest.get("result") if latest else None,
            "updated_at": latest.get("finished_at")
            or latest.get("started_at")
            or latest.get("created_at")
            if latest
            else None,
        }

    chunkable = kind in ("note", "wiki_topic")
    stages = {
        "chunk_embed": stage_state("chunk_embed", chunkable),
        "chunk_enrich": stage_state("chunk_enrich", kind != "wiki_topic" and chunkable),
        "graph_topology": stage_state("graph_topology", chunkable),
        "wiki_abstract": stage_state("wiki_abstract", kind == "wiki_topic"),
        "note_classify": stage_state("note_classify", kind == "note"),
    }
    return {
        "document_id": str(doc),
        "kind": kind or "doc",
        "content_sha": content_sha,
        "entity_count": int(entity_count or 0),
        "chunk_total": int(counts["chunk_total"] if counts else 0),
        "embedded_chunk_count": int(counts["embedded_chunk_count"] if counts else 0),
        "stages": stages,
        "runs": processing_runs,
        "processing_runs": processing_runs[:30],
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
                "keywords": _json_value(ch["keywords"], []) or [],
                "summarized": bool(ch["summary_sha"]),
                "last_error": None,
                "updated_at": ch["updated_at"].isoformat()
                if ch["updated_at"]
                else None,
            }
            for ch in wiki_chapters
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
            }
            for c in chunks
        ],
        "tag_segments": [
            {
                "id": str(t["id"]),
                "line_start": int(t["start_line"]),
                "line_end": int(t["end_line"]),
                "tag": t["tag"],
                "confidence": float(t["confidence"] or 0),
                "summary": t["summary"] or "",
                "meta": _json_value(t["meta"], {}) or {},
            }
            for t in tag_segs
        ],
        "note_tag_suggestions": [
            {
                "id": str(s["id"]),
                "run_id": str(s["run_id"]) if s["run_id"] else None,
                "tag": s["tag"],
                "user_tag": s["tag"],
                "confidence": float(s["confidence"] or 0),
                "reason": s["reasoning"],
                "reasoning": s["reasoning"],
                "status": s["status"],
                "created_at": s["proposed_at"].isoformat()
                if s["proposed_at"]
                else None,
                "decided_at": s["reviewed_at"].isoformat()
                if s["reviewed_at"]
                else None,
            }
            for s in suggestions
        ],
        "document_links": [
            {
                "target_document_id": str(l["target_document_id"]),
                "target_name": l["target_name"],
                "relation_type": l["relation_type"],
                "score": float(l["score"] or 0),
                "evidence": _json_value(l["evidence"], {}) or {},
                "run_id": str(l["run_id"]) if l["run_id"] else None,
                "created_at": l["created_at"].isoformat() if l["created_at"] else None,
            }
            for l in links
        ],
    }


def _chunk_text(text: str, target_size: int = 600, overlap: int = 80) -> list[str]:
    """Split on blank lines, then greedily pack into ~target_size-char
    chunks with a small overlap so a sentence straddling the boundary
    still retrieves against both chunks. Simple + deterministic; good
    enough for prose / notes / markdown.
    """
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    chunks: list[str] = []
    buf = ""
    for para in paragraphs:
        if len(buf) + len(para) <= target_size:
            buf = f"{buf}\n\n{para}".strip() if buf else para
            continue
        if buf:
            chunks.append(buf)
            # carry a tail of the previous chunk into the next for overlap
            tail = buf[-overlap:] if len(buf) > overlap else ""
            buf = f"{tail}\n\n{para}" if tail else para
        else:
            # single paragraph longer than target_size — keep whole; chunking
            # mid-sentence hurts retrieval more than a slightly oversize row.
            chunks.append(para)
            buf = ""
    if buf:
        chunks.append(buf)
    return chunks
