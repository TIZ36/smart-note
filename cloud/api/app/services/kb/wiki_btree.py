"""Smartsheet-hybrid wiki index over Postgres ltree (decision K).

A wiki "node" is a topic at a labelled hierarchy path
(`tech.frontend.react.hooks`). ltree gives us cheap ancestor /
descendant / pattern queries; we don't roll our own B+ tree. The
"smartsheet" overlay (column groupings, derived metrics) lives in
`attrs JSONB` until usage stabilizes.

API stays small on purpose — hierarchy ops are the load-bearing path:
upsert / list-by-prefix / descendants / move-subtree.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from app.common.db import pool

_LABEL_RE = re.compile(r"[A-Za-z0-9_]+")


def normalize_path(raw: str) -> str:
    """Coerce arbitrary input into a valid ltree label path.

    ltree labels are `[A-Za-z0-9_]+`. We slug each segment, drop empties,
    and join with `.`. Empty path → 'root' so we never insert NULL.
    """
    segs = [m.group(0) for m in _LABEL_RE.finditer(raw or "")]
    return ".".join(segs) if segs else "root"


@dataclass
class WikiNode:
    id: str
    path: str
    title: str
    summary: str
    source_ids: list[str]
    attrs: dict[str, Any]
    created_at: str
    updated_at: str


def _row(r) -> WikiNode:
    raw_attrs = r["attrs"]
    if isinstance(raw_attrs, str):
        raw_attrs = json.loads(raw_attrs) if raw_attrs else {}
    return WikiNode(
        id=str(r["id"]),
        path=str(r["path"]),
        title=r["title"],
        summary=r["summary"] or "",
        source_ids=[str(x) for x in (r["source_ids"] or [])],
        attrs=dict(raw_attrs or {}),
        created_at=r["created_at"].isoformat(),
        updated_at=r["updated_at"].isoformat(),
    )


async def upsert_node(
    workspace_id: str,
    path: str,
    title: str,
    summary: str = "",
    source_ids: list[str] | None = None,
    attrs: dict[str, Any] | None = None,
) -> WikiNode:
    ws = UUID(workspace_id)
    norm = normalize_path(path)
    src_uuids = [UUID(s) for s in (source_ids or [])]
    async with pool().acquire() as conn:
        row = await conn.fetchrow(
            """
            INSERT INTO wiki_nodes
                (workspace_id, path, title, summary, source_ids, attrs)
            VALUES ($1, $2::ltree, $3, $4, $5::uuid[], $6::jsonb)
            ON CONFLICT (workspace_id, path) DO UPDATE
              SET title = EXCLUDED.title,
                  summary = EXCLUDED.summary,
                  source_ids = EXCLUDED.source_ids,
                  attrs = wiki_nodes.attrs || EXCLUDED.attrs,
                  updated_at = now()
            RETURNING *
            """,
            ws, norm, title, summary, src_uuids, json.dumps(attrs or {}),
        )
    return _row(row)


async def get_node(workspace_id: str, path: str) -> WikiNode | None:
    async with pool().acquire() as conn:
        row = await conn.fetchrow(
            "SELECT * FROM wiki_nodes WHERE workspace_id=$1 AND path=$2::ltree",
            UUID(workspace_id), normalize_path(path),
        )
    return _row(row) if row else None


async def descendants(
    workspace_id: str, prefix: str, limit: int = 200,
) -> list[WikiNode]:
    """Everything under `prefix` (inclusive of the node at prefix)."""
    async with pool().acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT * FROM wiki_nodes
            WHERE workspace_id=$1 AND path <@ $2::ltree
            ORDER BY path
            LIMIT $3
            """,
            UUID(workspace_id), normalize_path(prefix), limit,
        )
    return [_row(r) for r in rows]


async def children(workspace_id: str, parent: str) -> list[WikiNode]:
    """Direct children only (one level deeper)."""
    parent_norm = normalize_path(parent)
    pattern = f"{parent_norm}.*{{1}}"
    async with pool().acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT * FROM wiki_nodes
            WHERE workspace_id=$1 AND path ~ $2::lquery
            ORDER BY path
            """,
            UUID(workspace_id), pattern,
        )
    return [_row(r) for r in rows]


async def move_subtree(
    workspace_id: str, from_prefix: str, to_prefix: str,
) -> int:
    """Re-parent every node under `from_prefix` to live under `to_prefix`.
    Returns rowcount. ltree handles the path-rewrite via subpath()."""
    src = normalize_path(from_prefix)
    dst = normalize_path(to_prefix)
    async with pool().acquire() as conn:
        # subpath(path, nlevel(src)) strips the src prefix, leaving only
        # the tail (empty for the src node itself). Concatenating with
        # dst rewrites the prefix in-place.
        result = await conn.execute(
            """
            UPDATE wiki_nodes
            SET path = CASE
                  WHEN path = $1::ltree THEN $2::ltree
                  ELSE ($2::ltree || subpath(path, nlevel($1::ltree)))::ltree
                END,
                updated_at = now()
            WHERE workspace_id=$3 AND path <@ $1::ltree
            """,
            src, dst, UUID(workspace_id),
        )
    return int(result.rsplit(" ", 1)[-1])


async def delete_subtree(workspace_id: str, prefix: str) -> int:
    async with pool().acquire() as conn:
        result = await conn.execute(
            "DELETE FROM wiki_nodes WHERE workspace_id=$1 AND path <@ $2::ltree",
            UUID(workspace_id), normalize_path(prefix),
        )
    return int(result.rsplit(" ", 1)[-1])
