"""6-path hybrid retrieval over the cloud `chunks` table.

Mirrors `services/kb/hybrid.py` but queries `chunks` (document-derived
text) rather than `memories` (agent-curated facts). Same scoring
primitives, different data source — UI Search panel reads from here
when looking for snippets inside the user's notes/wiki.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from dataclasses import dataclass, field
from uuid import UUID

from app.common.db import pool
from app.services.embedding.client import embed_one, format_vector_literal

CANDIDATE_PER_PATH = 100
NGRAM_N = 2
DEFAULT_WEIGHTS = {
    "fts": 0.25, "sub": 0.10, "ngram": 0.05,
    "vec": 0.45, "kw": 0.10, "tag_meta": 0.05,
}

log = logging.getLogger(__name__)
_TOKEN_RE = re.compile(r"[A-Za-z0-9_]+|[一-鿿]+")


@dataclass
class ChunkHit:
    id: str
    document_id: str
    dimension: str
    text: str
    keywords: list[str]
    line_start: int
    line_end: int
    source_ref: str
    document_name: str
    score: float
    path_scores: dict[str, float] = field(default_factory=dict)


def _tokens(text: str) -> set[str]:
    return {m.lower() for m in _TOKEN_RE.findall(text or "")}


def _ngrams(text: str) -> set[str]:
    t = (text or "").lower()
    if len(t) < NGRAM_N:
        return set()
    return {t[i:i + NGRAM_N] for i in range(len(t) - NGRAM_N + 1)}


def _ngram_score(q: str, doc: str) -> float:
    qn, dn = _ngrams(q), _ngrams(doc)
    if not qn or not dn:
        return 0.0
    return len(qn & dn) / len(qn)


def _substring_score(q: str, doc: str) -> float:
    if not q or not doc:
        return 0.0
    ql, dl = q.lower(), doc.lower()
    if ql not in dl:
        return 0.0
    pos = dl.index(ql)
    return 1.0 - min(pos / max(len(dl), 1), 0.5)


def _keyword_score(q_tokens: set[str], chunk_keywords: list[str]) -> float:
    if not q_tokens or not chunk_keywords:
        return 0.0
    kw = {k.lower() for k in chunk_keywords if k}
    return len(q_tokens & kw) / max(len(q_tokens), 1)


def _tag_meta_score(q_tokens: set[str], dimension: str) -> float:
    meta = _tokens(dimension or "")
    if not q_tokens or not meta:
        return 0.0
    return len(q_tokens & meta) / max(len(q_tokens), 1)


def _fts_rank_to_score(pos: int, total: int) -> float:
    if total <= 0:
        return 0.0
    return max(0.0, 1.0 - pos / total)


async def _fetch_vec(conn, ws: UUID, qvec_lit: str, dimension: str | None,
                    limit: int) -> list[dict]:
    base = (
        "SELECT c.id, c.document_id, c.dimension, c.text, c.keywords, "
        "c.line_start, c.line_end, c.source_ref, d.name AS document_name, "
        "1 - (c.embedding <=> $2::vector) AS vec_score "
        "FROM chunks c JOIN documents d ON d.id = c.document_id "
        "WHERE c.workspace_id = $1 AND c.embedding IS NOT NULL"
    )
    args = [ws, qvec_lit]
    if dimension:
        base += " AND c.dimension = $4"
        args.append(dimension)
    base += " ORDER BY c.embedding <=> $2::vector LIMIT $3"
    args.insert(2, limit)
    rows = await conn.fetch(base, *args)
    return [dict(r) for r in rows]


async def _fetch_fts(conn, ws: UUID, query: str, dimension: str | None,
                    limit: int) -> list[dict]:
    base = (
        "SELECT c.id, c.document_id, c.dimension, c.text, c.keywords, "
        "c.line_start, c.line_end, c.source_ref, d.name AS document_name, "
        "ts_rank_cd(c.text_tsv, plainto_tsquery('simple', $2)) AS fts_rank "
        "FROM chunks c JOIN documents d ON d.id = c.document_id "
        "WHERE c.workspace_id = $1 "
        "AND c.text_tsv @@ plainto_tsquery('simple', $2)"
    )
    args = [ws, query]
    if dimension:
        base += " AND c.dimension = $4"
        args.append(dimension)
    base += " ORDER BY fts_rank DESC LIMIT $3"
    args.insert(2, limit)
    rows = await conn.fetch(base, *args)
    return [dict(r) for r in rows]


async def _fetch_sub(conn, ws: UUID, query: str, dimension: str | None,
                    limit: int) -> list[dict]:
    base = (
        "SELECT c.id, c.document_id, c.dimension, c.text, c.keywords, "
        "c.line_start, c.line_end, c.source_ref, d.name AS document_name "
        "FROM chunks c JOIN documents d ON d.id = c.document_id "
        "WHERE c.workspace_id = $1 AND c.text ILIKE '%' || $2 || '%'"
    )
    args = [ws, query]
    if dimension:
        base += " AND c.dimension = $4"
        args.append(dimension)
    base += " LIMIT $3"
    args.insert(2, limit)
    rows = await conn.fetch(base, *args)
    return [dict(r) for r in rows]


async def search(
    query: str,
    workspace_id: str,
    *,
    topk: int = 20,
    dimension: str | None = None,
) -> list[ChunkHit]:
    if not query or not query.strip():
        return []

    qvec = await embed_one(query)
    qvec_lit = format_vector_literal(qvec) if qvec is not None else None
    q_tokens = _tokens(query)
    ws_uuid = UUID(workspace_id)

    async with pool().acquire() as conn:
        fts_rows = await _fetch_fts(conn, ws_uuid, query, dimension, CANDIDATE_PER_PATH)
        sub_rows = await _fetch_sub(conn, ws_uuid, query, dimension, CANDIDATE_PER_PATH)
        vec_rows = (
            await _fetch_vec(conn, ws_uuid, qvec_lit, dimension, CANDIDATE_PER_PATH)
            if qvec_lit else []
        )

    # Union by chunk id; merge per-path scores.
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
        pool_by_id.setdefault(str(r["id"]), r)

    out: list[ChunkHit] = []
    for rid, r in pool_by_id.items():
        text = r.get("text") or ""
        kws = r.get("keywords") or []
        if isinstance(kws, str):
            try:
                kws = json.loads(kws)
            except Exception:
                kws = []
        path_scores = {
            "fts": _fts_rank_to_score(
                r.get("_fts_pos", CANDIDATE_PER_PATH),
                r.get("_fts_total", CANDIDATE_PER_PATH),
            ) if "_fts_pos" in r else 0.0,
            "sub": _substring_score(query, text),
            "ngram": _ngram_score(query, text),
            "vec": float(r.get("vec_score") or 0.0),
            "kw": _keyword_score(q_tokens, list(kws)),
            "tag_meta": _tag_meta_score(q_tokens, r.get("dimension") or ""),
        }
        score = sum(DEFAULT_WEIGHTS[k] * path_scores[k] for k in path_scores)
        out.append(ChunkHit(
            id=rid,
            document_id=str(r["document_id"]),
            dimension=r.get("dimension") or "",
            text=text,
            keywords=list(kws or []),
            line_start=int(r.get("line_start") or 0),
            line_end=int(r.get("line_end") or 0),
            source_ref=r.get("source_ref") or "",
            document_name=r.get("document_name") or "",
            score=score,
            path_scores=path_scores,
        ))

    out.sort(key=lambda h: h.score, reverse=True)
    return out[:topk]
