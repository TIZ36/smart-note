"""Wiki node hierarchy router (smartsheet-hybrid via ltree)."""

from __future__ import annotations

import hashlib
import json
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from app.common import ws_registry
from app.common.db import pool
from app.deps import Identity, require_scope
from app.infra.canonical import canonical_sha
from app.services import processing_runs as runs_ledger
from app.services.kb.entity_graph import upsert_entities_for_segments
from app.services.kb import wiki_btree

router = APIRouter(prefix="/v1/wiki", tags=["wiki"])


class WikiUpsert(BaseModel):
    path: str
    title: str
    summary: str = ""
    source_ids: list[str] = Field(default_factory=list)
    attrs: dict[str, Any] = Field(default_factory=dict)


class WikiOut(BaseModel):
    id: str
    path: str
    title: str
    summary: str
    source_ids: list[str]
    attrs: dict[str, Any]
    created_at: str
    updated_at: str


class WikiChapterArtifact(BaseModel):
    ord: int
    level: int = 2
    anchor: str
    title: str
    line_start: int
    line_end: int
    summary: str = ""
    keywords: list[str] = Field(default_factory=list)
    entities: list[dict[str, Any]] = Field(default_factory=list)
    summary_sha: str | None = None


class WikiChaptersReplace(BaseModel):
    base_content_sha: str | None = None
    chapters: list[WikiChapterArtifact]
    executor: str = "client"


class WikiChaptersReplaceOut(BaseModel):
    document_id: str
    chapters: int
    summarized: int
    run_id: str | None = None


def _to_out(n: wiki_btree.WikiNode) -> WikiOut:
    return WikiOut(**n.__dict__)


def _content_sha(content: str) -> str:
    return hashlib.sha256((content or "").encode("utf-8")).hexdigest()


def _broadcast(workspace_id: str, payload: dict) -> None:
    import asyncio

    try:
        asyncio.create_task(ws_registry.broadcast(workspace_id, payload))
    except Exception:
        pass


@router.put(
    "/documents/{document_id}/chapters",
    response_model=WikiChaptersReplaceOut,
    dependencies=[Depends(require_scope("documents:write"))],
)
async def replace_document_chapters(
    document_id: str,
    req: WikiChaptersReplace,
    identity: Identity = Depends(require_scope("documents:write")),
) -> WikiChaptersReplaceOut:
    """Overwrite client-produced wiki chapter artifacts.

    Cloud is the canonical storage/query layer; the active desktop owns
    parsing + LLM summarization and uploads the finished sheet. The write
    is atomic per document and guarded by optional base_content_sha.
    """
    ws = UUID(identity.workspace_id)
    doc = UUID(document_id)
    content = ""
    async with pool().acquire() as conn:
        row = await conn.fetchrow(
            "SELECT content, metadata FROM documents WHERE id=$1 AND workspace_id=$2",
            doc,
            ws,
        )
        if not row:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "document not found")
        content = row["content"] or ""
        if req.base_content_sha and req.base_content_sha != _content_sha(content):
            raise HTTPException(
                status.HTTP_409_CONFLICT, "document changed; refresh and rebuild"
            )
        meta = row["metadata"] or {}
        if isinstance(meta, str):
            try:
                meta = json.loads(meta)
            except Exception:
                meta = {}
        if (meta.get("smartnote_type") or "") != "wiki_topic":
            raise HTTPException(
                status.HTTP_409_CONFLICT, "document is not a wiki_topic"
            )

    run_id = await runs_ledger.start(
        workspace_id=identity.workspace_id,
        document_id=document_id,
        kind="wiki_abstract",
        revision=1,
        executor=req.executor or "client",
        api_key_id=identity.api_key_id,
    )

    summarized = sum(1 for ch in req.chapters if ch.summary.strip())
    content_lines = content.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    async with pool().acquire() as conn:
        async with conn.transaction():
            await conn.execute("DELETE FROM wiki_chapters WHERE document_id=$1", doc)
            for ch in sorted(req.chapters, key=lambda c: c.ord):
                summary_sha = ch.summary_sha
                if not summary_sha:
                    body = "\n".join(
                        content_lines[max(ch.line_start - 1, 0) : ch.line_end]
                    )
                    summary_sha = canonical_sha(body)
                await conn.execute(
                    """
                    INSERT INTO wiki_chapters
                      (workspace_id, document_id, ord, level, anchor, title,
                       line_start, line_end, summary, keywords, summary_sha,
                       last_error, updated_at)
                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,NULL,now())
                    """,
                    ws,
                    doc,
                    ch.ord,
                    ch.level,
                    ch.anchor,
                    ch.title,
                    ch.line_start,
                    ch.line_end,
                    ch.summary,
                    json.dumps(ch.keywords, ensure_ascii=False),
                    summary_sha,
                )
                if ch.entities:
                    await upsert_entities_for_segments(
                        conn,
                        identity.workspace_id,
                        [{"tag": f"wiki:{ch.title}", "entities": ch.entities}],
                    )
        await conn.execute(
            "UPDATE documents SET updated_at = now() WHERE id=$1 AND workspace_id=$2",
            doc,
            ws,
        )

    result = {
        "chapters": len(req.chapters),
        "summarized": summarized,
        "skipped": 0,
        "failed": 0,
        "executor": req.executor or "client",
    }
    if run_id:
        await runs_ledger.finish(run_id=run_id, status="done", result=result)
    _broadcast(
        identity.workspace_id,
        {
            "type": "wiki_abstract_done",
            "document_id": document_id,
            **result,
        },
    )
    return WikiChaptersReplaceOut(
        document_id=document_id,
        chapters=len(req.chapters),
        summarized=summarized,
        run_id=run_id,
    )


@router.post(
    "/nodes",
    response_model=WikiOut,
    dependencies=[Depends(require_scope("documents:write"))],
)
async def upsert(
    req: WikiUpsert,
    identity: Identity = Depends(require_scope("documents:write")),
) -> WikiOut:
    n = await wiki_btree.upsert_node(
        identity.workspace_id,
        req.path,
        req.title,
        req.summary,
        req.source_ids,
        req.attrs,
    )
    return _to_out(n)


@router.get(
    "/nodes/{path:path}",
    response_model=WikiOut,
    dependencies=[Depends(require_scope("documents:read"))],
)
async def get_one(
    path: str,
    identity: Identity = Depends(require_scope("documents:read")),
) -> WikiOut:
    n = await wiki_btree.get_node(identity.workspace_id, path)
    if not n:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "node not found")
    return _to_out(n)


@router.get(
    "/descendants",
    response_model=list[WikiOut],
    dependencies=[Depends(require_scope("documents:read"))],
)
async def list_descendants(
    prefix: str = "root",
    limit: int = 200,
    identity: Identity = Depends(require_scope("documents:read")),
) -> list[WikiOut]:
    rows = await wiki_btree.descendants(identity.workspace_id, prefix, limit)
    return [_to_out(r) for r in rows]


@router.get(
    "/children",
    response_model=list[WikiOut],
    dependencies=[Depends(require_scope("documents:read"))],
)
async def list_children(
    parent: str = "root",
    identity: Identity = Depends(require_scope("documents:read")),
) -> list[WikiOut]:
    rows = await wiki_btree.children(identity.workspace_id, parent)
    return [_to_out(r) for r in rows]


class MoveRequest(BaseModel):
    from_prefix: str
    to_prefix: str


@router.post("/move", dependencies=[Depends(require_scope("documents:write"))])
async def move(
    req: MoveRequest,
    identity: Identity = Depends(require_scope("documents:write")),
) -> dict[str, int]:
    n = await wiki_btree.move_subtree(
        identity.workspace_id, req.from_prefix, req.to_prefix
    )
    return {"moved": n}


@router.delete(
    "/nodes/{path:path}", dependencies=[Depends(require_scope("documents:write"))]
)
async def delete_path(
    path: str,
    identity: Identity = Depends(require_scope("documents:write")),
) -> dict[str, int]:
    n = await wiki_btree.delete_subtree(identity.workspace_id, path)
    return {"deleted": n}
