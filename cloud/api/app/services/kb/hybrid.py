"""6-path hybrid retrieval over cloud memories (pgvector).

Ported from `server/app/retrieval.py` but adapted to the cloud schema
(Postgres + pgvector) and the cloud memory shape (content + tags +
embedding). The local version operated on `chunks` with per-segment
tag metadata; cloud's `memories` table is flatter but the scoring
primitives are identical — this module is the cross-device authority.

Paths (matches what the desktop SourceCard chips render):

* **fts**      — Postgres FTS on `to_tsvector(content)` (token match)
* **sub**      — case-insensitive substring LIKE (raw lexical)
* **ngram**    — Python char-bigram overlap (typo-tolerant)
* **vec**      — pgvector cosine similarity
* **kw**       — query-token ∩ memory.tags overlap
* **tag_meta** — query-token ∩ memory.scope / kind / author hint

Candidates are unioned from the three SQL-cheap paths (fts + vec + sub,
top-100 each), then rescored across all six in Python. For MVP
workspace sizes (< 10k memories) this is trivial; we'll revisit if any
path hits a latency ceiling.

Caller gets `HybridResult.path_scores` back so the UI can show which
paths actually matched this hit (the "6-path claim made visible"
chip row).
"""

from __future__ import annotations

import asyncio
import re
from dataclasses import dataclass, field
from typing import Any
from uuid import UUID

from app.common.db import pool
from app.services.embedding.client import embed_one, format_vector_literal

# ── Tunables ──────────────────────────────────────────────────
CANDIDATE_PER_PATH = 100   # top-N per SQL path before Python rerank
NGRAM_N = 2
DEFAULT_WEIGHTS = {
    "fts": 0.25,
    "sub": 0.10,
    "ngram": 0.05,
    "vec": 0.40,
    "kw": 0.10,
    "tag_meta": 0.10,
}


@dataclass
class HybridResult:
    id: str
    kind: str
    scope: str
    content: str
    tags: list[str]
    pinned: bool
    author_agent: str
    created_at: str
    score: float
    path_scores: dict[str, float] = field(default_factory=dict)


# ── Scoring primitives (pure python, operate on already-fetched rows) ──

_TOKEN_RE = re.compile(r"[A-Za-z0-9\u4e00-\u9fff]+")


def _tokens(text: str) -> set[str]:
    return {t.lower() for t in _TOKEN_RE.findall(text or "") if t}


def _ngrams(text: str, n: int = NGRAM_N) -> set[str]:
    t = (text or "").lower()
    return {t[i:i + n] for i in range(len(t) - n + 1)} if len(t) >= n else set()


def _ngram_score(q: str, doc: str) -> float:
    qn, dn = _ngrams(q), _ngrams(doc)
    if not qn or not dn:
        return 0.0
    return len(qn & dn) / len(qn)  # recall of query ngrams in doc


def _substring_score(q: str, doc: str) -> float:
    if not q or not doc:
        return 0.0
    ql, dl = q.lower(), doc.lower()
    if ql in dl:
        # slight boost for earlier matches
        pos = dl.index(ql)
        return 1.0 - min(pos / max(len(dl), 1), 0.5)
    return 0.0


def _keyword_score(q_tokens: set[str], tags: list[str]) -> float:
    if not q_tokens or not tags:
        return 0.0
    tag_tokens = {t.lower() for t in tags if t}
    return len(q_tokens & tag_tokens) / max(len(q_tokens), 1)


def _tag_meta_score(q_tokens: set[str], scope: str, kind: str, author: str) -> float:
    meta_tokens = _tokens(f"{scope} {kind} {author}")
    if not q_tokens or not meta_tokens:
        return 0.0
    return len(q_tokens & meta_tokens) / max(len(q_tokens), 1)


def _fts_rank_to_score(rank_pos: int, total: int) -> float:
    """Position → [0,1] so hit #1 scores 1.0 and the tail decays."""
    if total <= 0:
        return 0.0
    return max(0.0, 1.0 - rank_pos / total)


# ── Candidate fetch (SQL) ────────────────────────────────────

async def _fetch_vec_candidates(
    conn, workspace_id: UUID, qvec_lit: str, limit: int
) -> list[dict]:
    rows = await conn.fetch(
        """
        SELECT id, kind, scope, content, tags, pinned, author_agent, created_at,
               1 - (embedding <=> $2::vector) AS vec_score
        FROM memories
        WHERE workspace_id = $1
          AND embedding IS NOT NULL
          AND (status IN ('active', 'draft') OR pinned = true)
        ORDER BY embedding <=> $2::vector
        LIMIT $3
        """,
        workspace_id, qvec_lit, limit,
    )
    return [dict(r) for r in rows]


async def _fetch_fts_candidates(
    conn, workspace_id: UUID, query: str, limit: int
) -> list[dict]:
    # plainto_tsquery handles arbitrary user input safely. We don't own a
    # materialized tsvector column yet — when retrieval latency becomes
    # the bottleneck, add `content_tsv` + GIN index.
    rows = await conn.fetch(
        """
        SELECT id, kind, scope, content, tags, pinned, author_agent, created_at,
               ts_rank_cd(to_tsvector('simple', content), plainto_tsquery('simple', $2)) AS fts_rank
        FROM memories
        WHERE workspace_id = $1
          AND (status IN ('active', 'draft') OR pinned = true)
          AND to_tsvector('simple', content) @@ plainto_tsquery('simple', $2)
        ORDER BY fts_rank DESC
        LIMIT $3
        """,
        workspace_id, query, limit,
    )
    return [dict(r) for r in rows]


async def _fetch_sub_candidates(
    conn, workspace_id: UUID, query: str, limit: int
) -> list[dict]:
    rows = await conn.fetch(
        """
        SELECT id, kind, scope, content, tags, pinned, author_agent, created_at
        FROM memories
        WHERE workspace_id = $1
          AND (status IN ('active', 'draft') OR pinned = true)
          AND content ILIKE '%' || $2 || '%'
        LIMIT $3
        """,
        workspace_id, query, limit,
    )
    return [dict(r) for r in rows]


# ── Main entry ───────────────────────────────────────────────

async def hybrid_search(
    query: str,
    workspace_id: str,
    topk: int = 10,
    weights: dict[str, float] | None = None,
) -> list[HybridResult]:
    if not query or not query.strip():
        return []

    w = {**DEFAULT_WEIGHTS, **(weights or {})}
    ws_uuid = UUID(workspace_id)
    qvec = await embed_one(query)
    qvec_lit = format_vector_literal(qvec) if qvec is not None else None
    q_tokens = _tokens(query)

    async with pool().acquire() as conn:
        tasks = [
            _fetch_fts_candidates(conn, ws_uuid, query, CANDIDATE_PER_PATH),
            _fetch_sub_candidates(conn, ws_uuid, query, CANDIDATE_PER_PATH),
        ]
        if qvec_lit is not None:
            tasks.append(_fetch_vec_candidates(conn, ws_uuid, qvec_lit, CANDIDATE_PER_PATH))
        # asyncpg connection is not concurrent-safe across queries on the
        # SAME connection, so run sequentially here. Union happens after.
        fts_rows, sub_rows = await tasks[0], await tasks[1]
        vec_rows = await tasks[2] if len(tasks) == 3 else []

    # Union by id
    pool_by_id: dict[str, dict] = {}
    fts_total = len(fts_rows)
    for pos, r in enumerate(fts_rows):
        rid = str(r["id"])
        pool_by_id.setdefault(rid, r)
        pool_by_id[rid]["_fts_pos"] = pos
        pool_by_id[rid]["_fts_total"] = fts_total
    for r in vec_rows:
        rid = str(r["id"])
        existing = pool_by_id.setdefault(rid, r)
        existing["vec_score"] = r.get("vec_score", 0.0)
    for r in sub_rows:
        rid = str(r["id"])
        pool_by_id.setdefault(rid, r)

    # Score every candidate across all 6 paths.
    out: list[HybridResult] = []
    for rid, r in pool_by_id.items():
        content = r.get("content") or ""
        path_scores = {
            "fts": _fts_rank_to_score(
                r.get("_fts_pos", CANDIDATE_PER_PATH),
                r.get("_fts_total", CANDIDATE_PER_PATH),
            ) if "_fts_pos" in r else 0.0,
            "sub": _substring_score(query, content),
            "ngram": _ngram_score(query, content),
            "vec": float(r.get("vec_score") or 0.0),
            "kw": _keyword_score(q_tokens, list(r.get("tags") or [])),
            "tag_meta": _tag_meta_score(
                q_tokens,
                r.get("scope") or "",
                r.get("kind") or "",
                r.get("author_agent") or "",
            ),
        }
        blended = sum(w[k] * path_scores[k] for k in path_scores)
        if r.get("pinned"):
            blended += 1.0
        out.append(
            HybridResult(
                id=rid,
                kind=r.get("kind") or "",
                scope=r.get("scope") or "",
                content=content,
                tags=list(r.get("tags") or []),
                pinned=bool(r.get("pinned")),
                author_agent=r.get("author_agent") or "",
                created_at=(r["created_at"].isoformat()
                            if hasattr(r.get("created_at"), "isoformat") else str(r.get("created_at") or "")),
                score=blended,
                path_scores=path_scores,
            )
        )

    out.sort(key=lambda h: h.score, reverse=True)
    return out[:topk]
