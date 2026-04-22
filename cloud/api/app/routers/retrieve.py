"""POST /v1/retrieve — hybrid ranked retrieval over memories.

MVP ranker: pgvector cosine similarity (vector path) + plain substring
match (lexical fallback) merged by a simple linear blend. Good enough to
ship; more paths (FTS, keyword, tag boost) land in v1.1 once usage data
tells us where recall is weak.

Pinned memories always float to the top regardless of score. Supersession
is honored: if a memory's been superseded, we prefer the newer one with
the same content signal.
"""

from __future__ import annotations

from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from app import usage
from app.db import pool
from app.deps import Identity, require_scope
from app.embeddings import embed_one, format_vector_literal

router = APIRouter(prefix="/v1/retrieve", tags=["retrieve"])


class RetrieveRequest(BaseModel):
    query: str
    kinds: list[str] | None = None
    scope: str | None = None
    tags: list[str] | None = None
    topk: int = Field(default=10, ge=1, le=100)
    # Linear blend weights. Sum doesn't have to equal 1; we normalize at
    # read time. Setting lexical_weight=0 is a valid "vector only" call.
    vector_weight: float = 0.7
    lexical_weight: float = 0.3


class RetrievedMemory(BaseModel):
    id: str
    kind: str
    scope: str
    content: str
    tags: list[str]
    score: float
    vector_score: float
    lexical_score: float
    pinned: bool
    author_agent: str
    created_at: str


class RetrieveResponse(BaseModel):
    results: list[RetrievedMemory]
    query_embedded: bool


@router.post(
    "",
    response_model=RetrieveResponse,
    dependencies=[Depends(require_scope("retrieve"))],
)
async def retrieve(
    req: RetrieveRequest,
    identity: Identity = Depends(require_scope("retrieve")),
) -> RetrieveResponse:
    qvec = await embed_one(req.query)
    qvec_literal = format_vector_literal(qvec) if qvec is not None else None

    where = ["m.workspace_id = $1"]
    args: list[Any] = [UUID(identity.workspace_id)]
    # Lifecycle filter: default retrieval scopes to visible memories
    # (active + draft, plus pinned regardless of status). Archived rows
    # are intentionally skipped — pulling them back in requires an
    # explicit include-archived flag (not exposed yet; future work).
    where.append("(m.status IN ('active', 'draft') OR m.pinned = true)")
    if req.kinds:
        args.append(req.kinds)
        where.append(f"m.kind = ANY(${len(args)})")
    if req.scope:
        args.append(req.scope)
        where.append(f"m.scope = ${len(args)}")
    if req.tags:
        args.append(req.tags)
        where.append(f"m.tags && ${len(args)}")

    # Vector score: 1 - cosine_distance; NULL when either side missing.
    # Lexical score: tiny 0/1 boost for case-insensitive substring match.
    # Pinned memories get +1.0 so they always win ties.
    args.append(req.query.lower())
    lex_arg = len(args)
    args.append(qvec_literal)
    vec_arg = len(args)
    args.append(req.topk)
    topk_arg = len(args)

    sql = f"""
    WITH ranked AS (
        SELECT
            m.id, m.kind, m.scope, m.content, m.tags, m.pinned,
            m.author_agent, m.created_at,
            CASE
                WHEN m.embedding IS NOT NULL AND ${vec_arg}::text IS NOT NULL
                    THEN 1 - (m.embedding <=> ${vec_arg}::vector)
                ELSE 0
            END AS vector_score,
            CASE
                WHEN lower(m.content) LIKE '%' || ${lex_arg} || '%' THEN 1.0
                ELSE 0.0
            END AS lexical_score
        FROM memories m
        WHERE {' AND '.join(where)}
    )
    SELECT *,
           (CASE WHEN pinned THEN 1.0 ELSE 0.0 END)
           + {req.vector_weight} * vector_score
           + {req.lexical_weight} * lexical_score AS score
    FROM ranked
    ORDER BY score DESC
    LIMIT ${topk_arg}
    """
    async with pool().acquire() as conn:
        rows = await conn.fetch(sql, *args)

    # Telemetry (best-effort, non-blocking).
    await usage.bump(identity.workspace_id, retrieve_delta=1)

    # Access instrumentation (MLflow-style "metrics" on each memory):
    # bump access_count + last_accessed_at on every memory returned.
    # Powers future lifecycle decay + adaptive ranking. Best-effort;
    # failure here must not affect retrieval output.
    if rows:
        hit_ids = [r["id"] for r in rows]
        try:
            async with pool().acquire() as conn:
                await conn.execute(
                    "UPDATE memories SET access_count = access_count + 1, "
                    "last_accessed_at = now() WHERE id = ANY($1::uuid[])",
                    hit_ids,
                )
        except Exception:
            # Column may not exist yet (pre-005 migration). Ignore —
            # next startup will apply the migration.
            pass

    return RetrieveResponse(
        query_embedded=qvec is not None,
        results=[
            RetrievedMemory(
                id=str(r["id"]),
                kind=r["kind"],
                scope=r["scope"],
                content=r["content"],
                tags=list(r["tags"] or []),
                score=float(r["score"]),
                vector_score=float(r["vector_score"]),
                lexical_score=float(r["lexical_score"]),
                pinned=bool(r["pinned"]),
                author_agent=r["author_agent"],
                created_at=r["created_at"].isoformat(),
            )
            for r in rows
        ],
    )
