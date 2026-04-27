"""Knowledge graph endpoints — `/v1/graph` and `/v1/graph/wiki`.

Both read from `entities` + `entity_links` + `tag_entities`, populated
by the enrich classifier (services/kb/entity_graph.py). The desktop's
WikiGraph + InsightsPanel render this directly; same shape as the
local server's /graph for drop-in compatibility.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel

from app.common.db import pool
from app.deps import Identity, require_scope
from app.services.kb.entity_graph import get_graph

router = APIRouter(prefix="/v1/graph", tags=["graph"])


class GraphNode(BaseModel):
    id: str
    name: str
    type: str
    mentions: int


class GraphEdge(BaseModel):
    source: str
    target: str
    source_name: str
    target_name: str
    relation: str
    weight: int


class GraphStats(BaseModel):
    total_chunks: int
    total_entities: int
    total_memories: int
    total_feedback: int
    tags: dict[str, dict[str, int]]


class GraphResponse(BaseModel):
    nodes: list[GraphNode]
    edges: list[GraphEdge]
    tag_entities: dict[str, list[dict]]
    stats: GraphStats


@router.get(
    "",
    response_model=GraphResponse,
    dependencies=[Depends(require_scope("documents:read"))],
)
async def graph(
    top_n: int = Query(default=200, ge=10, le=1000),
    identity: Identity = Depends(require_scope("documents:read")),
) -> GraphResponse:
    async with pool().acquire() as conn:
        out = await get_graph(conn, identity.workspace_id, top_n=top_n)
    return GraphResponse(**out)


@router.get(
    "/wiki",
    response_model=GraphResponse,
    dependencies=[Depends(require_scope("documents:read"))],
)
async def wiki_graph(
    top_n: int = Query(default=200, ge=10, le=1000),
    identity: Identity = Depends(require_scope("documents:read")),
) -> GraphResponse:
    """Wiki-flavored graph: nodes are entities tagged under any
    `wiki:*` topic. Filter applied client-side from the full graph
    so we don't fork the persistence schema."""
    async with pool().acquire() as conn:
        full = await get_graph(conn, identity.workspace_id, top_n=top_n)
    wiki_only = {
        tag: ents for tag, ents in full["tag_entities"].items()
        if tag.startswith("wiki:")
    }
    keep = {e["name"] for ents in wiki_only.values() for e in ents}
    full["nodes"] = [n for n in full["nodes"] if n["name"] in keep]
    keep_ids = {n["id"] for n in full["nodes"]}
    full["edges"] = [
        e for e in full["edges"]
        if e["source"] in keep_ids and e["target"] in keep_ids
    ]
    full["tag_entities"] = wiki_only
    return GraphResponse(**full)
