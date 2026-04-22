"""Memory proposal queue.

Pattern taken from MLflow's autolog philosophy adapted for agent memory:
agents submit *proposals* (low-confidence candidates with a reason) that
land as `status='draft'` memories. A reviewer (user via UI or an agent
following policy) then accepts, edits+accepts, or rejects each proposal.

Why this exists:
  * Every LLM prompt "should I save this as a memory?" has a non-trivial
    false-positive rate. The cost of false positives is cluttered
    workspace → bad retrieval → user stops trusting the memory layer.
  * Rather than trusting a single LLM call to hard-decide, we split:
    agent makes the proposal (cheap, low confidence), human-or-policy
    makes the commit (explicit, high confidence).
  * Accepted proposals carry the proposer (`author_agent`) + original
    reason forward, so the workspace has a lineage of "why is this
    memory here?" — MLflow-like run metadata.

Endpoints (all gated by memories:write for proposer; memories:read for
list; memories:write for accept/reject):

  POST   /v1/memories/proposals              — submit
  GET    /v1/memories/proposals              — list draft queue
  POST   /v1/memories/proposals/{id}/accept  — promote draft → active
  POST   /v1/memories/proposals/{id}/reject  — archive (keep lineage)
  POST   /v1/memories/proposals/batch-accept — accept a batch by ids

Dedup: on propose, we run a vector-similarity check against the
workspace's active memories. If any exceed 0.88 cosine similarity, the
response includes a `similar_existing` hint so the reviewer can merge
instead of creating a near-duplicate.
"""

from __future__ import annotations

from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from app import usage
from app.db import pool
from app.deps import Identity, require_scope
from app.embeddings import embed_one, format_vector_literal

router = APIRouter(prefix="/v1/memories/proposals", tags=["proposals"])


VALID_KINDS = {"fact", "preference", "procedure", "episode", "document_ref"}

# Cosine similarity threshold above which a proposal is flagged as
# near-duplicate of an existing active memory. Calibrated for the
# default `all-MiniLM-L6-v2` embedder: 0.75 ≈ "these are the same
# idea expressed differently" (catches "reply in Chinese" vs
# "respond in Chinese by default"); 0.88+ only catches verbatim.
# Users running a stronger embedder may want to raise this.
DEDUP_SIM_THRESHOLD = 0.75


# ── Pydantic ────────────────────────────────────────────────────


class SimilarMemory(BaseModel):
    id: str
    kind: str
    content: str
    similarity: float


class ProposalCreate(BaseModel):
    kind: str
    content: str
    reason: str | None = None           # why this is worth remembering
    scope: str = "global"
    structured: dict[str, Any] | None = None
    tags: list[str] = Field(default_factory=list)
    confidence: float = 0.5              # default lower than explicit writes
    source_refs: list[dict[str, Any]] = Field(default_factory=list)


class ProposalOut(BaseModel):
    id: str
    workspace_id: str
    author_agent: str
    kind: str
    scope: str
    content: str
    structured: dict[str, Any] | None = None
    tags: list[str]
    source_refs: list[dict[str, Any]]
    confidence: float
    proposal_reason: str | None = None
    created_at: str
    similar_existing: list[SimilarMemory] = Field(default_factory=list)


class ProposalAccept(BaseModel):
    # Reviewer can edit before accepting — saves the "close but needs
    # a tweak" round-trip. Omitted fields keep the draft's values.
    content: str | None = None
    structured: dict[str, Any] | None = None
    tags: list[str] | None = None
    confidence: float | None = None
    pinned: bool | None = None
    # When set, the accepted memory supersedes an existing one — the
    # common merge case when propose returned similar_existing.
    supersedes: str | None = None


class ProposalReject(BaseModel):
    reason: str | None = None


class BatchAcceptRequest(BaseModel):
    ids: list[str]


# ── Helpers ─────────────────────────────────────────────────────


def _row_to_proposal(row, similar: list[SimilarMemory] | None = None) -> ProposalOut:
    d = dict(row)
    return ProposalOut(
        id=str(d["id"]),
        workspace_id=str(d["workspace_id"]),
        author_agent=d["author_agent"],
        kind=d["kind"],
        scope=d["scope"],
        content=d["content"],
        structured=d.get("structured"),
        tags=list(d.get("tags") or []),
        source_refs=list(d.get("source_refs") or []),
        confidence=float(d.get("confidence") or 0),
        proposal_reason=d.get("proposal_reason"),
        created_at=d["created_at"].isoformat(),
        similar_existing=similar or [],
    )


async def _find_similar_existing(
    workspace_id: UUID, embedding_literal: str, kind: str,
) -> list[SimilarMemory]:
    """Return existing ACTIVE memories of the same kind with cosine
    similarity above DEDUP_SIM_THRESHOLD. Used to tell the reviewer
    'this might already exist'."""
    async with pool().acquire() as conn:
        rows = await conn.fetch(
            "SELECT id, kind, content, "
            "1 - (embedding <=> $1::vector) AS sim "
            "FROM memories "
            "WHERE workspace_id = $2 AND status IN ('active', 'draft') "
            "AND embedding IS NOT NULL AND kind = $3 "
            "ORDER BY embedding <=> $1::vector ASC LIMIT 3",
            embedding_literal, workspace_id, kind,
        )
    out: list[SimilarMemory] = []
    for r in rows:
        sim = float(r["sim"])
        if sim >= DEDUP_SIM_THRESHOLD:
            out.append(SimilarMemory(
                id=str(r["id"]), kind=r["kind"],
                content=r["content"][:200],
                similarity=sim,
            ))
    return out


# ── Endpoints ───────────────────────────────────────────────────


@router.post(
    "",
    response_model=ProposalOut,
    dependencies=[Depends(require_scope("memories:write"))],
)
async def create_proposal(
    req: ProposalCreate,
    identity: Identity = Depends(require_scope("memories:write")),
) -> ProposalOut:
    if req.kind not in VALID_KINDS:
        raise HTTPException(422, f"kind must be one of {sorted(VALID_KINDS)}")
    if not req.content.strip():
        raise HTTPException(422, "content cannot be empty")

    vec = await embed_one(req.content)
    vec_literal = format_vector_literal(vec) if vec is not None else None

    workspace = UUID(identity.workspace_id)

    # Similarity dedup — best-effort. Proceed even if it fails (e.g.
    # embed service down): better to create the draft than block on
    # a non-critical hint.
    similar: list[SimilarMemory] = []
    if vec_literal:
        try:
            similar = await _find_similar_existing(workspace, vec_literal, req.kind)
        except Exception:
            similar = []

    async with pool().acquire() as conn:
        row = await conn.fetchrow(
            """
            INSERT INTO memories(
              workspace_id, author_agent, kind, scope, content, structured,
              embedding, confidence, source_refs, tags, status, proposal_reason
            ) VALUES (
              $1, $2, $3, $4, $5, $6,
              $7::vector, $8, $9, $10, 'draft', $11
            )
            RETURNING id, workspace_id, author_agent, kind, scope, content,
                      structured, confidence, source_refs, tags,
                      proposal_reason, created_at
            """,
            workspace,
            identity.agent_id or "unknown",
            req.kind,
            req.scope,
            req.content,
            req.structured,
            vec_literal,
            req.confidence,
            req.source_refs,
            req.tags,
            req.reason,
        )
    # Drafts also count toward memory_count — they're real rows. Users
    # will see this in the usage panel so they can tell when an agent
    # is being noisy.
    await usage.bump(identity.workspace_id, memory_delta=1)
    return _row_to_proposal(row, similar=similar)


@router.get(
    "",
    dependencies=[Depends(require_scope("memories:read"))],
)
async def list_proposals(
    identity: Identity = Depends(require_scope("memories:read")),
    kind: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
) -> dict:
    """List draft-status memories. Ordered by newest first so fresh
    proposals surface at the top of a review session."""
    args: list[Any] = [UUID(identity.workspace_id)]
    where = ["workspace_id = $1", "status = 'draft'"]
    if kind:
        args.append(kind); where.append(f"kind = ${len(args)}")
    args.extend([limit, offset])
    sql = (
        "SELECT id, workspace_id, author_agent, kind, scope, content, "
        "       structured, confidence, source_refs, tags, "
        "       proposal_reason, created_at "
        "FROM memories WHERE " + " AND ".join(where) +
        f" ORDER BY created_at DESC LIMIT ${len(args) - 1} OFFSET ${len(args)}"
    )
    async with pool().acquire() as conn:
        rows = await conn.fetch(sql, *args)
        total = await conn.fetchval(
            "SELECT COUNT(*) FROM memories "
            "WHERE workspace_id = $1 AND status = 'draft'"
            + (" AND kind = $2" if kind else ""),
            UUID(identity.workspace_id), *( [kind] if kind else [] ),
        )
    return {
        "proposals": [_row_to_proposal(r).model_dump() for r in rows],
        "total": int(total or 0),
    }


@router.post(
    "/{proposal_id}/accept",
    response_model=dict,
    dependencies=[Depends(require_scope("memories:write"))],
)
async def accept_proposal(
    proposal_id: str,
    req: ProposalAccept,
    identity: Identity = Depends(require_scope("memories:write")),
) -> dict:
    """Promote a draft to active.

    Optional edits in the request body replace the draft's fields
    before promotion — saves a "close-but-needs-a-tweak" round trip.
    If `supersedes` is set, the accepted memory marks an existing
    memory as its antecedent (preferred merge flow).
    """
    workspace = UUID(identity.workspace_id)
    async with pool().acquire() as conn:
        existing = await conn.fetchrow(
            "SELECT id, status, content, structured, tags, confidence "
            "FROM memories WHERE id = $1 AND workspace_id = $2",
            UUID(proposal_id), workspace,
        )
        if not existing:
            raise HTTPException(404, "proposal not found")
        if existing["status"] != "draft":
            raise HTTPException(409, f"not a draft (current status: {existing['status']})")

        sets = [
            "status = 'active'",
            "reviewed_at = now()",
            "reviewed_by = $3",
            "updated_at = now()",
        ]
        args: list[Any] = [UUID(proposal_id), workspace, identity.agent_id or "unknown"]

        # If reviewer edits, re-embed when content changes.
        if req.content is not None and req.content != existing["content"]:
            args.append(req.content); sets.append(f"content = ${len(args)}")
            vec = await embed_one(req.content)
            if vec is not None:
                args.append(format_vector_literal(vec))
                sets.append(f"embedding = ${len(args)}::vector")
        if req.structured is not None:
            args.append(req.structured); sets.append(f"structured = ${len(args)}")
        if req.tags is not None:
            args.append(req.tags); sets.append(f"tags = ${len(args)}")
        if req.confidence is not None:
            args.append(req.confidence); sets.append(f"confidence = ${len(args)}")
        else:
            # Accept defaults to confidence=1.0 — reviewer just
            # endorsed it, treat as strong.
            sets.append("confidence = 1.0")
        if req.pinned is not None:
            args.append(req.pinned); sets.append(f"pinned = ${len(args)}")
        if req.supersedes is not None:
            args.append(UUID(req.supersedes)); sets.append(f"supersedes = ${len(args)}")

        sql = (
            "UPDATE memories SET " + ", ".join(sets) +
            " WHERE id = $1 AND workspace_id = $2 "
            "RETURNING id, status, reviewed_at, confidence, supersedes"
        )
        row = await conn.fetchrow(sql, *args)

    return {
        "ok": True,
        "id": str(row["id"]),
        "status": row["status"],
        "reviewed_at": row["reviewed_at"].isoformat(),
        "confidence": float(row["confidence"]),
        "supersedes": str(row["supersedes"]) if row["supersedes"] else None,
    }


@router.post(
    "/{proposal_id}/reject",
    dependencies=[Depends(require_scope("memories:write"))],
)
async def reject_proposal(
    proposal_id: str,
    req: ProposalReject,
    identity: Identity = Depends(require_scope("memories:write")),
) -> dict:
    """Mark a draft rejected. We archive rather than delete so the
    lineage survives — future heuristics can learn from "what the
    user rejected" to tune proposer behavior.

    The rejection reason is stored in `proposal_reason` appended
    after `[rejected: <reason>]` so it doesn't clobber the original
    proposer's reason.
    """
    workspace = UUID(identity.workspace_id)
    reason_tail = f"\n[rejected: {req.reason}]" if req.reason else "\n[rejected]"
    async with pool().acquire() as conn:
        result = await conn.execute(
            "UPDATE memories SET status = 'archived', "
            "reviewed_at = now(), reviewed_by = $1, "
            "proposal_reason = COALESCE(proposal_reason, '') || $2, "
            "updated_at = now() "
            "WHERE id = $3 AND workspace_id = $4 AND status = 'draft'",
            identity.agent_id or "unknown",
            reason_tail,
            UUID(proposal_id), workspace,
        )
    if not result.endswith(" 1"):
        raise HTTPException(404, "proposal not found or not in draft status")
    return {"ok": True, "id": proposal_id, "status": "archived"}


@router.post(
    "/batch-accept",
    dependencies=[Depends(require_scope("memories:write"))],
)
async def batch_accept_proposals(
    req: BatchAcceptRequest,
    identity: Identity = Depends(require_scope("memories:write")),
) -> dict:
    """Accept multiple proposals with default settings — convenience
    for "approve everything in this session's triage queue." Per-item
    edits aren't supported (use the single-id endpoint for those)."""
    workspace = UUID(identity.workspace_id)
    if not req.ids:
        return {"ok": True, "accepted": 0}
    uuid_ids = [UUID(i) for i in req.ids]
    async with pool().acquire() as conn:
        result = await conn.execute(
            "UPDATE memories SET status = 'active', "
            "reviewed_at = now(), reviewed_by = $1, "
            "confidence = 1.0, updated_at = now() "
            "WHERE id = ANY($2::uuid[]) AND workspace_id = $3 "
            "AND status = 'draft'",
            identity.agent_id or "unknown",
            uuid_ids, workspace,
        )
    parts = result.split()
    accepted = int(parts[-1]) if parts and parts[-1].isdigit() else 0
    return {"ok": True, "accepted": accepted, "requested": len(req.ids)}
