"""Documents + simple synchronous ingest.

MVP ingest = chunk document by paragraph, embed each chunk, store each as
a `document_ref` memory linking back to the document. Keeps the shape of
the full pipeline (document → chunks → retrievable memories) without
bringing over the OSS repo's pack/enrich machinery yet. v1.1 adds
async jobs + richer chunking.
"""

from __future__ import annotations

import re
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app import usage
from app.db import pool
from app.deps import Identity, require_scope
from app.embeddings import embed_texts, format_vector_literal

router = APIRouter(prefix="/v1/documents", tags=["documents"])


class DocumentCreate(BaseModel):
    name: str
    content: str
    kind: str = "text"
    metadata: dict | None = None


class DocumentOut(BaseModel):
    id: str
    workspace_id: str
    name: str
    kind: str
    byte_size: int
    ingested_at: str | None = None
    created_at: str


def _row_to_out(r) -> DocumentOut:
    return DocumentOut(
        id=str(r["id"]),
        workspace_id=str(r["workspace_id"]),
        name=r["name"],
        kind=r["kind"],
        byte_size=r["byte_size"],
        ingested_at=r["ingested_at"].isoformat() if r["ingested_at"] else None,
        created_at=r["created_at"].isoformat(),
    )


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
    async with pool().acquire() as conn:
        row = await conn.fetchrow(
            "INSERT INTO documents(workspace_id, name, kind, content, "
            "  metadata, byte_size) "
            "VALUES($1, $2, $3, $4, $5, $6) "
            "RETURNING id, workspace_id, name, kind, byte_size, ingested_at, "
            "          created_at",
            UUID(identity.workspace_id),
            req.name,
            req.kind,
            req.content,
            req.metadata or {},
            byte_size,
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
            "SELECT id, name, content, workspace_id FROM documents "
            "WHERE id = $1 AND workspace_id = $2",
            UUID(document_id), UUID(identity.workspace_id),
        )
    if not doc:
        raise HTTPException(404, "document not found")

    chunks = _chunk_text(doc["content"])
    if not chunks:
        return {"ok": True, "chunks": 0}

    vectors = await embed_texts(chunks)

    async with pool().acquire() as conn:
        async with conn.transaction():
            for chunk_text, vec in zip(chunks, vectors):
                vec_literal = format_vector_literal(vec) if vec is not None else None
                await conn.execute(
                    """
                    INSERT INTO memories(
                      workspace_id, author_agent, kind, scope, content,
                      structured, embedding, source_refs
                    ) VALUES (
                      $1, $2, 'document_ref', 'global', $3, $4, $5::vector, $6
                    )
                    """,
                    UUID(identity.workspace_id),
                    identity.agent_id or "ingest",
                    chunk_text,
                    {"document_id": str(doc["id"]), "document_name": doc["name"]},
                    vec_literal,
                    [{"document_id": str(doc["id"])}],
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
) -> dict:
    async with pool().acquire() as conn:
        rows = await conn.fetch(
            "SELECT id, workspace_id, name, kind, byte_size, ingested_at, "
            "       created_at "
            "FROM documents WHERE workspace_id = $1 ORDER BY created_at DESC",
            UUID(identity.workspace_id),
        )
    return {"documents": [_row_to_out(r).model_dump() for r in rows]}


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
