"""Unified processing run ledger + stage executors.

This is the canonical path used by the Library client. Every stage has
the same lifecycle: create a processing_runs row, emit progress events,
write artefacts, then mark the row terminal.
"""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from typing import Any, Literal
from uuid import UUID

from app.common.db import pool
from app.infra.canonical import canonical_sha
from app.services.realtime_protocol import broadcast, event_payload

ProcessingKind = Literal[
    "chunk_embed",
    "chunk_enrich",
    "graph_topology",
    "wiki_abstract",
    "note_classify",
]
TERMINAL = {"done", "failed", "skipped_dedup", "skipped_quota", "partial"}


@dataclass(frozen=True)
class StageError:
    code: str
    message: str
    retryable: bool = True

    def as_dict(self) -> dict[str, Any]:
        return {"code": self.code, "message": self.message, "retryable": self.retryable}


def _jsonify(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False)


def _hash_payload(payload: dict[str, Any]) -> str:
    return canonical_sha(json.dumps(payload, sort_keys=True, ensure_ascii=False))


async def _document_snapshot(workspace_id: str, document_id: str) -> dict[str, Any]:
    async with pool().acquire() as conn:
        row = await conn.fetchrow(
            "SELECT id, name, content, metadata, content_sha256 FROM documents "
            "WHERE id=$1 AND workspace_id=$2",
            UUID(document_id),
            UUID(workspace_id),
        )
    if not row:
        raise KeyError("document not found")
    meta = row["metadata"] or {}
    if isinstance(meta, str):
        try:
            meta = json.loads(meta)
        except Exception:
            meta = {}
    content = row["content"] or ""
    return {
        "id": str(row["id"]),
        "name": row["name"],
        "content": content,
        "metadata": meta if isinstance(meta, dict) else {},
        "content_sha": row["content_sha256"] or canonical_sha(content),
        "smartnote_type": (meta or {}).get("smartnote_type")
        if isinstance(meta, dict)
        else None,
    }


def _kind_allowed(
    kind: ProcessingKind, smartnote_type: str | None
) -> StageError | None:
    if kind == "chunk_enrich" and smartnote_type == "wiki_topic":
        return StageError(
            "wiki_only", "wiki_topic uses wiki_abstract instead of chunk_enrich", False
        )
    if kind == "wiki_abstract" and smartnote_type != "wiki_topic":
        return StageError(
            "wiki_only", "wiki_abstract only applies to wiki_topic documents", False
        )
    if kind == "note_classify" and smartnote_type != "note":
        return StageError(
            "note_only", "note_classify only applies to note documents", False
        )
    return None


async def _input_snapshot(
    workspace_id: str,
    doc: dict[str, Any],
    kind: ProcessingKind,
    options: dict[str, Any],
) -> dict[str, Any]:
    snap: dict[str, Any] = {
        "kind": kind,
        "content_sha": doc["content_sha"],
        "smartnote_type": doc.get("smartnote_type"),
        "options": options or {},
    }
    async with pool().acquire() as conn:
        if kind in ("chunk_enrich", "note_classify", "wiki_abstract"):
            rows = await conn.fetch(
                "SELECT name, description, color, sort_order FROM workspace_tags "
                "WHERE workspace_id=$1 ORDER BY sort_order, name",
                UUID(workspace_id),
            )
            tags = [dict(r) for r in rows]
            snap["tag_vocab"] = tags
            snap["tag_vocab_sha"] = _hash_payload({"tags": tags})
        if kind in ("chunk_enrich", "graph_topology"):
            upstream = await conn.fetchrow(
                "SELECT id, result, finished_at FROM processing_runs "
                "WHERE workspace_id=$1 AND document_id=$2 AND kind='chunk_embed' AND status='done' "
                "ORDER BY finished_at DESC NULLS LAST, created_at DESC LIMIT 1",
                UUID(workspace_id),
                UUID(doc["id"]),
            )
            snap["chunk_embed_run_id"] = str(upstream["id"]) if upstream else None
            snap["chunk_embed_result"] = upstream["result"] if upstream else None
        if kind == "graph_topology":
            for upstream_kind in ("chunk_enrich", "wiki_abstract", "note_classify"):
                upstream = await conn.fetchrow(
                    "SELECT id, result, finished_at FROM processing_runs "
                    "WHERE workspace_id=$1 AND document_id=$2 AND kind=$3 AND status='done' "
                    "ORDER BY finished_at DESC NULLS LAST, created_at DESC LIMIT 1",
                    UUID(workspace_id),
                    UUID(doc["id"]),
                    upstream_kind,
                )
                snap[f"{upstream_kind}_run_id"] = (
                    str(upstream["id"]) if upstream else None
                )
    return snap


async def start(
    *,
    workspace_id: str,
    document_id: str,
    kind: ProcessingKind,
    force: bool = False,
    options: dict[str, Any] | None = None,
    api_key_id: str | None = None,
    executor: str | None = None,
) -> dict[str, Any]:
    doc = await _document_snapshot(workspace_id, document_id)
    err = _kind_allowed(kind, doc.get("smartnote_type"))
    if err:
        raise ValueError(_jsonify(err.as_dict()))
    options = options or {}
    snap = await _input_snapshot(workspace_id, doc, kind, options)
    revision = 0
    if force:
        async with pool().acquire() as conn:
            revision = int(
                await conn.fetchval(
                    "SELECT COALESCE(MAX(revision), -1) + 1 FROM processing_runs "
                    "WHERE workspace_id=$1 AND document_id=$2 AND kind=$3",
                    UUID(workspace_id),
                    UUID(document_id),
                    kind,
                )
                or 0
            )
    snap["revision"] = revision
    input_sha = _hash_payload(snap)
    async with pool().acquire() as conn:
        if not force:
            existing = await conn.fetchrow(
                "SELECT * FROM processing_runs WHERE workspace_id=$1 AND document_id=$2 "
                "AND kind=$3 AND input_sha=$4 AND status IN ('queued','running','done') "
                "ORDER BY created_at DESC LIMIT 1",
                UUID(workspace_id),
                UUID(document_id),
                kind,
                input_sha,
            )
            if existing:
                return _row_to_response(existing, dedup=True)
        row = await conn.fetchrow(
            """
            INSERT INTO processing_runs(
              workspace_id, document_id, kind, status, executor, input_sha,
              input_snapshot, revision, trigger_kind, trigger_ref, progress
            ) VALUES ($1,$2,$3,'queued',$4,$5,$6::jsonb,$7,'api_key',$8,'{}'::jsonb)
            RETURNING *
            """,
            UUID(workspace_id),
            UUID(document_id),
            kind,
            executor,
            input_sha,
            _jsonify(snap),
            revision,
            api_key_id or "unknown",
        )
    await emit(
        str(row["id"]), status="queued", message="Queued", data={"phase": "queued"}
    )
    return _row_to_response(row, dedup=False)


def _row_to_response(row: Any, *, dedup: bool = False) -> dict[str, Any]:
    result = (
        row["result"]
        if isinstance(row["result"], dict)
        else (json.loads(row["result"]) if row["result"] else None)
    )
    err = row["error"]
    if isinstance(err, str) and err.startswith("{"):
        try:
            err = json.loads(err)
        except Exception:
            pass
    return {
        "run_id": str(row["id"]),
        "document_id": str(row["document_id"]),
        "kind": row["kind"],
        "status": row["status"],
        "revision": int(row["revision"] or 0),
        "dedup_skipped": dedup,
        "result": result,
        "error": err,
    }


async def get_run(run_id: str, workspace_id: str) -> dict[str, Any] | None:
    async with pool().acquire() as conn:
        row = await conn.fetchrow(
            "SELECT r.*, d.name AS document_name FROM processing_runs r "
            "JOIN documents d ON d.id=r.document_id "
            "WHERE r.id=$1 AND r.workspace_id=$2",
            UUID(run_id),
            UUID(workspace_id),
        )
        if not row:
            return None
        events = await conn.fetch(
            "SELECT event, status, message, error, data, at FROM pipeline_events "
            "WHERE run_id=$1 AND workspace_id=$2 ORDER BY at ASC, id ASC",
            UUID(run_id),
            UUID(workspace_id),
        )
    return _run_detail(row, events)


async def list_runs(
    workspace_id: str,
    *,
    document_id: str | None = None,
    kind: str | None = None,
    status: str | None = None,
    limit: int = 50,
) -> list[dict[str, Any]]:
    where = ["workspace_id=$1"]
    args: list[Any] = [UUID(workspace_id)]
    if document_id:
        args.append(UUID(document_id))
        where.append(f"document_id=${len(args)}")
    if kind:
        args.append(kind)
        where.append(f"kind=${len(args)}")
    if status:
        args.append(status)
        where.append(f"status=${len(args)}")
    args.append(max(1, min(limit, 200)))
    async with pool().acquire() as conn:
        rows = await conn.fetch(
            "SELECT * FROM processing_runs WHERE "
            + " AND ".join(where)
            + f" ORDER BY created_at DESC LIMIT ${len(args)}",
            *args,
        )
    return [_run_row(r) for r in rows]


def _run_row(r: Any) -> dict[str, Any]:
    result = r["result"] or {}
    if isinstance(result, str):
        try:
            result = json.loads(result)
        except Exception:
            result = {}
    error = r["error"]
    if isinstance(error, str) and error.startswith("{"):
        try:
            error = json.loads(error)
        except Exception:
            pass
    duration_ms = None
    if r["started_at"] and r["finished_at"]:
        duration_ms = int((r["finished_at"] - r["started_at"]).total_seconds() * 1000)
    return {
        "run_id": str(r["id"]),
        # Plain `id` alias too — desktop's ProcessingRunRow type
        # treats id as the run id (matches the /kn payload).
        "id": str(r["id"]),
        # Required for cross-document rollups (the desktop's
        # useDocPipelineStates hook keys runs by document_id to
        # populate the left-tree per-row bits). Without it, every
        # run falls into a single undefined-keyed bucket and the
        # tree shows "not processed" for everything.
        "document_id": str(r["document_id"]),
        "kind": r["kind"],
        "status": r["status"],
        "started_at": r["started_at"].isoformat()
        if r["started_at"]
        else r["created_at"].isoformat(),
        "finished_at": r["finished_at"].isoformat() if r["finished_at"] else None,
        "duration_ms": duration_ms,
        "executor": r["executor"],
        "tokens_total": result.get("total_tokens") or result.get("tokens_total"),
        "error": error,
    }


def _run_detail(row: Any, events: list[Any]) -> dict[str, Any]:
    out = _run_row(row)
    out.update(
        {
            "document_id": str(row["document_id"]),
            "document_name": row["document_name"],
            "body": row["result"] or {},
            "events": [
                {
                    "type": e["event"],
                    "event": e["event"],
                    "status": e["status"],
                    "message": e["message"],
                    "error": e["error"],
                    "data": e["data"] or {},
                    "at": e["at"].isoformat() if e["at"] else None,
                }
                for e in events
            ],
        }
    )
    return out


async def emit(
    run_id: str,
    *,
    status: str,
    message: str | None = None,
    progress_current: int | None = None,
    progress_total: int | None = None,
    data: dict[str, Any] | None = None,
    error: StageError | None = None,
) -> None:
    async with pool().acquire() as conn:
        row = await conn.fetchrow(
            "SELECT id, workspace_id, document_id, kind FROM processing_runs WHERE id=$1",
            UUID(run_id),
        )
    if not row:
        return
    event = (
        "processing_done"
        if status in ("done", "failed", "partial", "skipped_dedup", "skipped_quota")
        else "processing_progress"
    )
    broadcast(
        str(row["workspace_id"]),
        event_payload(
            event=event,
            workspace_id=str(row["workspace_id"]),
            document_id=str(row["document_id"]),
            run_id=run_id,
            stage=row["kind"],
            status=status,
            progress_current=progress_current,
            progress_total=progress_total,
            message=message,
            error=error.as_dict() if error else None,
            data=data,
        ),
    )


async def mark_running(run_id: str, *, executor: str, message: str) -> None:
    async with pool().acquire() as conn:
        await conn.execute(
            "UPDATE processing_runs SET status='running', executor=$2, attempts=attempts+1, "
            "started_at=COALESCE(started_at, now()) WHERE id=$1",
            UUID(run_id),
            executor,
        )
    await emit(run_id, status="running", message=message, data={"phase": "started"})


async def finish(
    run_id: str,
    *,
    status: str,
    result: dict[str, Any] | None = None,
    error: StageError | None = None,
    message: str | None = None,
) -> None:
    async with pool().acquire() as conn:
        await conn.execute(
            "UPDATE processing_runs SET status=$2, result=$3::jsonb, error=$4, finished_at=now() WHERE id=$1",
            UUID(run_id),
            status,
            _jsonify(result or {}),
            _jsonify(error.as_dict()) if error else None,
        )
    await emit(
        run_id, status=status, message=message or status, data=result or {}, error=error
    )


async def cancel(run_id: str, workspace_id: str) -> None:
    err = StageError("cancelled", "Processing run was cancelled", False)
    async with pool().acquire() as conn:
        row = await conn.fetchrow(
            """
            UPDATE processing_runs
            SET status='failed', error=$3, finished_at=now()
            WHERE id=$1 AND workspace_id=$2 AND status IN ('queued','running')
            RETURNING id
            """,
            UUID(run_id),
            UUID(workspace_id),
            _jsonify(err.as_dict()),
        )
    if row:
        await emit(run_id, status="failed", message=err.message, error=err)


async def execute(run_id: str, *, force: bool = False) -> dict[str, Any]:
    async with pool().acquire() as conn:
        row = await conn.fetchrow(
            "SELECT * FROM processing_runs WHERE id=$1", UUID(run_id)
        )
    if not row:
        raise KeyError("run not found")
    kind = row["kind"]
    try:
        if kind == "chunk_embed":
            result = await _run_chunk_embed(row)
        elif kind == "chunk_enrich":
            result = await _run_chunk_enrich(row)
        elif kind == "wiki_abstract":
            result = await _run_wiki_abstract(row)
        elif kind == "note_classify":
            result = await _run_note_classify(row)
        elif kind == "graph_topology":
            result = await _run_graph_topology(row)
        else:
            raise ValueError(f"unknown kind: {kind}")
        return result
    except Exception as exc:
        err = _coerce_error(exc)
        await finish(str(row["id"]), status="failed", error=err, message=err.message)
        raise


def _coerce_error(exc: Exception) -> StageError:
    if isinstance(exc, ValueError):
        try:
            raw = json.loads(str(exc))
            return StageError(
                raw.get("code", "internal"),
                raw.get("message", str(exc)),
                bool(raw.get("retryable", True)),
            )
        except Exception:
            pass
    return StageError("internal", str(exc), True)


async def _run_chunk_embed(row: Any) -> dict[str, Any]:
    await mark_running(
        str(row["id"]), executor="cloud_embed", message="Embedding document chunks"
    )
    from app.contexts.knowledge import service as knowledge

    doc = await _document_snapshot(str(row["workspace_id"]), str(row["document_id"]))
    ran = await knowledge.ingest_document_for_kind(
        str(row["workspace_id"]), str(row["document_id"]), doc.get("smartnote_type")
    )
    if not ran:
        raise ValueError(
            _jsonify(
                StageError(
                    "internal", "document kind is not chunkable", False
                ).as_dict()
            )
        )
    async with pool().acquire() as conn:
        count = int(
            await conn.fetchval(
                "SELECT count(*) FROM chunks WHERE workspace_id=$1 AND document_id=$2",
                row["workspace_id"],
                row["document_id"],
            )
            or 0
        )
    result = {"chunk_count": count, "content_sha": doc["content_sha"]}
    await finish(
        str(row["id"]), status="done", result=result, message=f"Indexed {count} chunks"
    )
    return result


async def _workspace_tags(workspace_id: str) -> list[str]:
    async with pool().acquire() as conn:
        rows = await conn.fetch(
            "SELECT name FROM workspace_tags WHERE workspace_id=$1 ORDER BY sort_order, name",
            UUID(workspace_id),
        )
    return [r["name"] for r in rows]


async def _run_chunk_enrich(row: Any) -> dict[str, Any]:
    from app.services.enrich.classifier import DEFAULT_TAGS, run_classify
    from app.services.enrich.executors.cloud_pool import _load_provider
    from app.services.kb.entity_graph import upsert_entities_for_segments

    cfg = await _load_provider(str(row["workspace_id"]))
    if cfg is None:
        raise ValueError(
            _jsonify(
                StageError(
                    "no_executor_available", "Cloud AI provider is not configured", True
                ).as_dict()
            )
        )
    await mark_running(
        str(row["id"]), executor="cloud_pool", message="Classifying chunks"
    )
    doc = await _document_snapshot(str(row["workspace_id"]), str(row["document_id"]))
    tags = await _workspace_tags(str(row["workspace_id"])) or DEFAULT_TAGS
    total_lines = len((doc["content"] or "").splitlines()) or 1

    loop = asyncio.get_running_loop()

    def on_progress(done: int, total: int) -> None:
        loop.call_soon_threadsafe(
            asyncio.create_task,
            emit(
                str(row["id"]),
                status="running",
                message=f"Classified {done}/{total} lines",
                progress_current=done,
                progress_total=total,
                data={"phase": "classify"},
            ),
        )

    out = await asyncio.to_thread(
        run_classify,
        doc["content"].splitlines(),
        cfg,
        tags,
        cfg.max_concurrency,
        on_progress,
    )
    await emit(
        str(row["id"]),
        status="running",
        message="Writing semantic segments",
        data={"phase": "writing"},
    )
    async with pool().acquire() as conn:
        async with conn.transaction():
            await conn.execute(
                "DELETE FROM tag_segments WHERE workspace_id=$1 AND document_id=$2",
                row["workspace_id"],
                row["document_id"],
            )
            for seg in out.segments:
                await conn.execute(
                    """
                    INSERT INTO tag_segments(workspace_id, document_id, start_line, end_line, tag, confidence, summary, meta)
                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
                    """,
                    row["workspace_id"],
                    row["document_id"],
                    int(seg.get("line_start", 1)),
                    int(seg.get("line_end", total_lines)),
                    str(seg.get("tag") or "others"),
                    float(seg.get("confidence", 0.0)),
                    str(seg.get("summary") or ""),
                    _jsonify(
                        {
                            "secondary_tags": seg.get("secondary_tags", []),
                            "topic_name": seg.get("topic_name", ""),
                            "keywords": seg.get("keywords", []),
                            "entities": seg.get("entities", []),
                            "is_credential": bool(seg.get("is_credential", False)),
                        }
                    ),
                )
            graph_counts = await upsert_entities_for_segments(
                conn, str(row["workspace_id"]), out.segments
            )
    result = {
        "segments": len(out.segments),
        "prompt_tokens": out.prompt_tokens,
        "completion_tokens": out.completion_tokens,
        "total_tokens": out.total_tokens,
        **graph_counts,
    }
    await finish(
        str(row["id"]),
        status="done",
        result=result,
        message=f"Created {len(out.segments)} semantic segments",
    )
    return result


async def _run_wiki_abstract(row: Any) -> dict[str, Any]:
    await mark_running(
        str(row["id"]), executor="cloud_pool", message="Summarizing wiki chapters"
    )
    await emit(
        str(row["id"]),
        status="running",
        message="Summarizing chapters",
        data={"phase": "summarizing"},
    )
    from app.contexts.knowledge.wiki_phase_b import summarize_document

    result = await summarize_document(str(row["workspace_id"]), str(row["document_id"]))
    if result.get("error"):
        raise ValueError(
            _jsonify(
                StageError("no_executor_available", result["error"], True).as_dict()
            )
        )
    status = "partial" if int(result.get("failed") or 0) else "done"
    await finish(
        str(row["id"]),
        status=status,
        result=result,
        message=f"Summarized {result.get('summarized', 0)} chapters",
    )
    return result


async def _run_note_classify(row: Any) -> dict[str, Any]:
    from app.routers.notes import _classify_via_provider

    tags = await _workspace_tags(str(row["workspace_id"]))
    if not tags:
        raise ValueError(
            _jsonify(
                StageError(
                    "no_user_tags",
                    "Create user tags before running note_classify",
                    False,
                ).as_dict()
            )
        )
    doc = await _document_snapshot(str(row["workspace_id"]), str(row["document_id"]))
    await mark_running(
        str(row["id"]), executor="cloud_pool", message="Classifying note into user tags"
    )
    suggestions, telemetry = await _classify_via_provider(
        str(row["workspace_id"]), doc["content"], tags
    )
    await emit(
        str(row["id"]),
        status="running",
        message="Writing tag suggestions",
        data={
            "phase": "writing",
            "tags_used": len({s.get("tag") for s in suggestions}),
        },
    )
    async with pool().acquire() as conn:
        async with conn.transaction():
            for s in suggestions:
                await conn.execute(
                    """
                    INSERT INTO note_tag_suggestions(workspace_id, document_id, run_id, tag, confidence, reasoning, status)
                    VALUES ($1,$2,$3,$4,$5,$6,'pending')
                    ON CONFLICT (workspace_id, document_id, tag) WHERE status='pending'
                    DO UPDATE SET run_id=EXCLUDED.run_id, confidence=EXCLUDED.confidence, reasoning=EXCLUDED.reasoning, proposed_at=now()
                    """,
                    row["workspace_id"],
                    row["document_id"],
                    row["id"],
                    s["tag"],
                    float(s.get("confidence", 0.0)),
                    s.get("reasoning"),
                )
    result = {"suggested_count": len(suggestions), "tags_total": len(tags), **telemetry}
    await finish(
        str(row["id"]),
        status="done",
        result=result,
        message=f"Suggested {len(suggestions)} tags",
    )
    return result


async def _doc_entities(conn, ws, doc_id) -> set[str]:
    """Union of entities for one document, pulling from BOTH sources:
      - tag_segments.meta.entities (notes / plain docs)
      - wiki_chapters.entities      (wiki_topic via wiki_abstract)
    Previously topology only queried tag_segments → wiki docs always
    returned an empty set → 0 cross-doc links for any wiki involvement.
    Result is normalised to lowercase names so case-differing mentions
    collapse (e.g. "DeepSeek" vs "deepseek")."""
    rows = await conn.fetch(
        """
        SELECT lower(ent->>'name') AS name
          FROM tag_segments ts,
               LATERAL jsonb_array_elements(COALESCE(ts.meta->'entities','[]'::jsonb)) ent
         WHERE ts.workspace_id=$1 AND ts.document_id=$2
           AND ent->>'name' IS NOT NULL
        UNION
        SELECT lower(ent->>'name') AS name
          FROM wiki_chapters wc,
               LATERAL jsonb_array_elements(COALESCE(wc.entities,'[]'::jsonb)) ent
         WHERE wc.workspace_id=$1 AND wc.document_id=$2
           AND ent->>'name' IS NOT NULL
        """,
        ws, doc_id,
    )
    return {r["name"] for r in rows if r["name"]}


async def _doc_tags(conn, ws, doc_id) -> set[str]:
    """Note tags come from tag_segments.tag; wiki "tags" are the
    chapter titles namespaced as `wiki:<title>`. Union both so a note
    tagged `learn` and a wiki chapter titled `learn` can match — the
    semantics differ but cross-doc affinity is the point."""
    rows = await conn.fetch(
        """
        SELECT DISTINCT tag FROM tag_segments
         WHERE workspace_id=$1 AND document_id=$2
        UNION
        SELECT DISTINCT 'wiki:'||title AS tag FROM wiki_chapters
         WHERE workspace_id=$1 AND document_id=$2
        """,
        ws, doc_id,
    )
    return {r["tag"] for r in rows if r["tag"]}


async def _run_graph_topology(row: Any) -> dict[str, Any]:
    await mark_running(
        str(row["id"]), executor="graph_topology", message="Scoring related documents"
    )
    source = row["document_id"]
    ws = row["workspace_id"]
    async with pool().acquire() as conn:
        source_tags = await _doc_tags(conn, ws, source)
        source_entities = await _doc_entities(conn, ws, source)
        source_chunks = await conn.fetch(
            "SELECT id, embedding FROM chunks WHERE workspace_id=$1 AND document_id=$2 AND embedding IS NOT NULL LIMIT 20",
            ws,
            source,
        )
        candidates = await conn.fetch(
            "SELECT id, name FROM documents WHERE workspace_id=$1 AND id<>$2",
            ws,
            source,
        )
        links: list[tuple[UUID, str, float, dict[str, Any]]] = []
        for cand in candidates:
            cand_id = cand["id"]
            cand_tags = await _doc_tags(conn, ws, cand_id)
            shared_tags = sorted(source_tags & cand_tags)
            cand_entities = await _doc_entities(conn, ws, cand_id)
            shared_entities = sorted(source_entities & cand_entities)
            if shared_entities:
                links.append(
                    (
                        cand_id,
                        "shared_entity",
                        min(0.95, 0.45 + 0.08 * len(shared_entities)),
                        {"entities": shared_entities[:10], "target_name": cand["name"]},
                    )
                )
            if shared_tags:
                links.append(
                    (
                        cand_id,
                        "shared_tag",
                        min(0.9, 0.4 + 0.08 * len(shared_tags)),
                        {"tags": shared_tags[:10], "target_name": cand["name"]},
                    )
                )
        await emit(
            str(row["id"]),
            status="running",
            message="Writing document links",
            data={
                "phase": "writing",
                "candidates": len(candidates),
                "links_found": len(links),
            },
        )
        async with conn.transaction():
            await conn.execute(
                "DELETE FROM document_links WHERE workspace_id=$1 AND source_document_id=$2",
                ws,
                source,
            )
            for target, rel, score, evidence in links[:50]:
                await conn.execute(
                    """
                    INSERT INTO document_links(workspace_id, source_document_id, target_document_id, relation_type, score, evidence, run_id)
                    VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)
                    ON CONFLICT (source_document_id, target_document_id, relation_type)
                    DO UPDATE SET score=EXCLUDED.score, evidence=EXCLUDED.evidence, run_id=EXCLUDED.run_id, created_at=now()
                    """,
                    ws,
                    source,
                    target,
                    rel,
                    score,
                    _jsonify(evidence),
                    row["id"],
                )
    result = {
        "candidates": len(candidates),
        "links_found": len(links),
        "by_relation": {
            "shared_entity": sum(1 for x in links if x[1] == "shared_entity"),
            "shared_tag": sum(1 for x in links if x[1] == "shared_tag"),
        },
    }
    await finish(
        str(row["id"]),
        status="done",
        result=result,
        message=f"Created {len(links)} document links",
    )
    return result
