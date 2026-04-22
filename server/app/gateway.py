from __future__ import annotations

import json
import time
from pathlib import Path

import requests
from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from app.adaptive import strengthen_profile
from app.config import settings
from app.db import connect, migrate_db
from app.embed import embed_texts
from app.knowledge_graph import get_graph
from app.memory import add_feedback, save_qa_memory
from app.rerank import rerank
from app.builds import get_active_build_id, list_builds, activate_build, delete_build
from app.tags import (
    get_all_tags,
    get_tags_with_desc,
    add_tag,
    delete_tag,
    reorder_tags,
    set_tag_color,
    TAG_COLORS,
)
from app.retrieval import search
from app.rewrite import (
    generate_candidate,
    get_candidate_status,
    approve_candidate,
    reject_candidate,
    record_validation,
)
from app.versioning import (
    list_versions,
    restore_version,
    create_snapshot,
    delete_version,
)
from app import skill
from app import packs
from app import views as note_views
from app import smart_table


app = FastAPI(title="SmartNote Gateway")

# Auto-migrate DB on startup
try:
    migrate_db()
except Exception:
    pass

# Runtime-editable settings: seed the DB on first launch from env-derived
# defaults, then overlay persisted values onto the in-memory singleton so later
# edits via POST /settings take effect without restarting the backend.
try:
    from app.config import seed_settings_if_empty, load_settings_from_db

    seed_settings_if_empty()
    load_settings_from_db()
except Exception:
    pass

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

smart_table.IMAGE_DIR.mkdir(parents=True, exist_ok=True)
app.mount(
    "/smart-table-images",
    StaticFiles(directory=str(smart_table.IMAGE_DIR)),
    name="smart-table-images",
)


# ── Request models ──


class SearchRequest(BaseModel):
    query: str
    topk: int = 20
    tag_filter: str | None = None
    include_wiki: list[str] = []  # Special knowledge topics to include (@mentions)


class RerankRequest(BaseModel):
    query: str
    result_ids: list[int]
    use_llm: bool = False
    topk: int = 8


class ChatHistoryItem(BaseModel):
    role: str  # "user" or "assistant"
    content: str


class ChatRequest(BaseModel):
    query: str
    evidence_ids: list[int] = []
    history: list[ChatHistoryItem] = []  # Previous Q&A for follow-ups
    source_files: list[
        str
    ] = []  # Full source files for deep context (populated by frontend from prior response)
    topk: int = 15


class FeedbackRequest(BaseModel):
    answer_id: int
    query_text: str = ""  # For strengthening query profiles
    feedback_type: str = "plus_one"


class SmartTableCreateRequest(BaseModel):
    name: str


class SmartTableRenameRequest(BaseModel):
    new_name: str


class SmartSheetCreateRequest(BaseModel):
    name: str


class SmartColumnCreateRequest(BaseModel):
    name: str
    type: str


class SmartColumnRenameRequest(BaseModel):
    new_name: str


class SmartSheetRenameRequest(BaseModel):
    new_name: str


class SmartCellUpdateRequest(BaseModel):
    row_id: int
    column_name: str
    value: dict | str
    source: str = "ui"


class SmartAppendColumnRequest(BaseModel):
    column_name: str
    values: list[dict | str]
    source: str = "mcp"


class SmartRowCreateRequest(BaseModel):
    values: dict[str, dict | str] = {}
    source: str = "ui"


class SmartRowsInsertRequest(BaseModel):
    rows: list[dict[str, dict | str]]
    source: str = "mcp"


# ── Stage 1: Recall ──


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "embedding_mode": settings.embedding_mode}


# ── Ingest progress SSE ──
# Lets the desktop app observe ingest runs that execute inside this gateway
# process (e.g. MCP-triggered). CLI-spawned ingests already stream over stderr.


@app.get("/events/ingest")
def api_events_ingest():
    from app.events import subscribe, unsubscribe

    q = subscribe()

    def gen():
        try:
            # Initial comment so the client knows the stream is open.
            yield ": connected\n\n"
            while True:
                try:
                    event = q.get(timeout=15)
                except Exception:
                    # Periodic keep-alive so NAT/proxies don't close idle streams.
                    yield ": ping\n\n"
                    continue
                yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
        finally:
            unsubscribe(q)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
        },
    )


@app.post("/search")
def api_search(req: SearchRequest) -> dict:
    """Stage 1: Wide recall with 5 retrieval paths + adaptive weights."""
    result = search(
        req.query,
        req.topk,
        tag_filter=req.tag_filter,
        include_wiki=req.include_wiki or None,
    )

    # Dual-search validation for active rewrite candidates (async, non-blocking)
    try:
        status = get_candidate_status()
        if status and status["status"] == "validating":
            top5 = result.get("results", [])[:5]
            old_score = sum(r.get("score", 0) for r in top5) / max(len(top5), 1)
            # For now, candidate score = old_score (will diverge after candidate is ingested)
            # TODO: actually search against candidate chunks
            record_validation(req.query, old_score, old_score)
    except Exception:
        pass  # Never fail search for validation

    # Save to search history (keep latest 20, prune old)
    try:
        results = result.get("results", [])
        result_count = len(results)
        top_score = float(results[0].get("score", 0)) if results else 0.0
        with connect() as conn:
            conn.execute(
                "INSERT INTO search_history(query_text, result_count, tag_filter) VALUES(?, ?, ?)",
                (req.query, result_count, req.tag_filter),
            )
            conn.execute(
                "DELETE FROM search_history WHERE id NOT IN (SELECT id FROM search_history ORDER BY created_at DESC LIMIT 20)"
            )
            # Track knowledge gaps: miss = no results, or top score weak.
            # Feeds the list_knowledge_gaps MCP tool so Claude can proactively
            # ingest docs to fill what the user keeps searching for.
            if result_count == 0 or top_score < 0.3:
                conn.execute(
                    "INSERT INTO search_misses(query_text, result_count, top_score, tag_filter) "
                    "VALUES(?, ?, ?, ?)",
                    (req.query, result_count, top_score, req.tag_filter),
                )
            conn.commit()
    except Exception:
        pass

    return result


@app.get("/smart-tables")
def api_list_smart_tables() -> dict:
    return {"tables": smart_table.list_tables()}


@app.post("/smart-tables")
def api_create_smart_table(req: SmartTableCreateRequest) -> dict:
    try:
        return {"table": smart_table.create_table(req.name.strip())}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.patch("/smart-tables/{table_name}")
def api_rename_smart_table(table_name: str, req: SmartTableRenameRequest) -> dict:
    try:
        return {"table": smart_table.rename_table(table_name, req.new_name.strip())}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.delete("/smart-tables/{table_name}")
def api_delete_smart_table(table_name: str) -> dict:
    try:
        return smart_table.delete_table(table_name)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.get("/smart-tables/{table_name}/sheets")
def api_list_smart_sheets(table_name: str) -> dict:
    try:
        return {"sheets": smart_table.list_sheets(table_name)}
    except Exception as e:
        raise HTTPException(status_code=404, detail=str(e))


@app.post("/smart-tables/{table_name}/sheets")
def api_create_smart_sheet(table_name: str, req: SmartSheetCreateRequest) -> dict:
    try:
        return {"sheet": smart_table.create_sheet(table_name, req.name.strip())}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.patch("/smart-tables/{table_name}/sheets/{sheet_name}")
def api_rename_smart_sheet(
    table_name: str, sheet_name: str, req: SmartSheetRenameRequest
) -> dict:
    try:
        return {
            "sheet": smart_table.rename_sheet(
                table_name, sheet_name, req.new_name.strip()
            )
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.delete("/smart-tables/{table_name}/sheets/{sheet_name}")
def api_delete_smart_sheet(table_name: str, sheet_name: str) -> dict:
    try:
        return smart_table.delete_sheet(table_name, sheet_name)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.get("/smart-tables/{table_name}/sheets/{sheet_name}")
def api_get_smart_sheet(table_name: str, sheet_name: str) -> dict:
    try:
        return smart_table.get_sheet(table_name, sheet_name)
    except Exception as e:
        raise HTTPException(status_code=404, detail=str(e))


@app.post("/smart-tables/{table_name}/sheets/{sheet_name}/columns")
def api_add_smart_column(
    table_name: str, sheet_name: str, req: SmartColumnCreateRequest
) -> dict:
    try:
        return {
            "column": smart_table.add_column(
                table_name, sheet_name, req.name.strip(), req.type
            )
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.patch("/smart-tables/{table_name}/sheets/{sheet_name}/columns/{column_name}")
def api_rename_smart_column(
    table_name: str,
    sheet_name: str,
    column_name: str,
    req: SmartColumnRenameRequest,
) -> dict:
    try:
        return {
            "column": smart_table.rename_column(
                table_name, sheet_name, column_name, req.new_name.strip()
            )
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.delete("/smart-tables/{table_name}/sheets/{sheet_name}/columns/{column_name}")
def api_delete_smart_column(table_name: str, sheet_name: str, column_name: str) -> dict:
    try:
        return smart_table.delete_column(table_name, sheet_name, column_name)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/smart-tables/{table_name}/sheets/{sheet_name}/rows")
def api_add_smart_row(
    table_name: str, sheet_name: str, req: SmartRowCreateRequest
) -> dict:
    try:
        return {
            "row": smart_table.add_row(
                table_name, sheet_name, req.values, source=req.source
            )
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/smart-tables/{table_name}/sheets/{sheet_name}/rows/batch")
def api_insert_smart_rows(
    table_name: str, sheet_name: str, req: SmartRowsInsertRequest
) -> dict:
    try:
        return smart_table.insert_rows(
            table_name, sheet_name, req.rows, source=req.source
        )
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.delete("/smart-tables/{table_name}/sheets/{sheet_name}/rows/{row_id}")
def api_delete_smart_row(table_name: str, sheet_name: str, row_id: int) -> dict:
    try:
        return smart_table.delete_row(table_name, sheet_name, row_id)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/smart-tables/{table_name}/sheets/{sheet_name}/cells")
def api_update_smart_cell(
    table_name: str, sheet_name: str, req: SmartCellUpdateRequest
) -> dict:
    try:
        return smart_table.update_cell(
            table_name,
            sheet_name,
            req.row_id,
            req.column_name,
            req.value,
            source=req.source,
        )
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/smart-tables/{table_name}/sheets/{sheet_name}/append-column")
def api_append_smart_column(
    table_name: str, sheet_name: str, req: SmartAppendColumnRequest
) -> dict:
    try:
        return smart_table.append_column_data(
            table_name,
            sheet_name,
            req.column_name,
            req.values,
            source=req.source,
        )
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.get("/smart-tables/{table_name}/sheets/{sheet_name}/history")
def api_get_smart_cell_history(
    table_name: str, sheet_name: str, row_id: int, column_name: str
) -> dict:
    try:
        return {
            "history": smart_table.get_cell_history(
                table_name, sheet_name, row_id, column_name
            )
        }
    except Exception as e:
        raise HTTPException(status_code=404, detail=str(e))


@app.post("/smart-tables/images")
async def api_upload_smart_table_image(file: UploadFile = File(...)) -> dict:
    try:
        payload = smart_table.save_image(
            file.filename or "image.bin", await file.read()
        )
        return {"image": payload}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


# ── Stage 2: Rerank ──


@app.post("/rerank")
def api_rerank(req: RerankRequest) -> dict:
    """Stage 2: Rerank recall results using embedding similarity or LLM."""
    result = rerank(req.query, req.result_ids, use_llm=req.use_llm, topk=req.topk)
    return result


# ── Stage 3: AI Answer ──


def _chat_completion(
    system: str, messages: list[dict], cacheable_prefix: str = ""
) -> str:
    """Call the configured chat provider.

    `cacheable_prefix`: when non-empty AND the provider is Anthropic
    (base_url contains 'anthropic'), wrap the prefix with a
    cache_control={"type": "ephemeral"} breakpoint — this flips input-token
    billing to 10x cheaper for repeat calls within ~5 min. Other providers
    quietly ignore the field.
    """
    if not getattr(settings, "ai_features_enabled", True):
        return "AI features are disabled in Settings."
    if not settings.provider_api_key:
        return "Provider API key not configured."

    headers = {
        "Authorization": f"Bearer {settings.provider_api_key}",
        "Content-Type": "application/json",
    }
    url = f"{settings.provider_base_url.rstrip('/')}/chat/completions"

    # B1: Anthropic prompt caching. We wrap the cacheable prefix as a system
    # content block with cache_control; the remainder stays uncached. Gated
    # by both provider detection and `prompt_cache_mode` so users can opt out
    # on proxies that route to Anthropic but reject the field.
    is_anthropic = "anthropic" in (settings.provider_base_url or "").lower()
    cache_mode = (getattr(settings, "prompt_cache_mode", "auto") or "auto").lower()
    cache_enabled = (cache_mode == "on") or (cache_mode == "auto" and is_anthropic)
    if cacheable_prefix and cache_enabled:
        system_blocks = [
            {
                "type": "text",
                "text": cacheable_prefix,
                "cache_control": {"type": "ephemeral"},
            },
        ]
        if system:
            system_blocks.append({"type": "text", "text": system})
        all_messages = [{"role": "system", "content": system_blocks}] + messages
    else:
        sys_text = (
            (cacheable_prefix + "\n\n" + system).strip() if cacheable_prefix else system
        )
        all_messages = [{"role": "system", "content": sys_text}] + messages

    payload = {
        "model": settings.provider_chat_model,
        "messages": all_messages,
        "temperature": 0.2,
    }
    resp = requests.post(url, headers=headers, json=payload, timeout=60)
    resp.raise_for_status()
    data = resp.json()
    return data["choices"][0]["message"]["content"]


def _meta_memory_prelude(query: str = "", limit: int = 12) -> str:
    """Format top meta-memory entries as a system-prompt prelude.

    Scope filtering: 'global' always included; scoped entries (tag/topic) are
    included when the query mentions the scope token verbatim. Keeps the
    prelude relevant without bloating token usage on every chat call.
    Bumps `hit_count` on memories that actually fire so the inspector shows
    which rules are pulling weight.
    """
    try:
        with connect() as conn:
            rows = conn.execute(
                "SELECT id, kind, text, scope FROM meta_memory "
                "ORDER BY hit_count DESC, updated_at DESC LIMIT ?",
                (limit,),
            ).fetchall()
    except Exception:
        return ""
    if not rows:
        return ""
    q_lower = (query or "").lower()
    picked: list[str] = []
    fired_ids: list[int] = []
    for r in rows:
        scope = (r["scope"] or "global").strip()
        if scope != "global" and scope.lower() not in q_lower:
            continue
        picked.append(f"  • [{r['kind']}] {r['text']}")
        fired_ids.append(int(r["id"]))
        if len(picked) >= 8:
            break
    if not picked:
        return ""
    try:
        with connect() as conn:
            ph = ",".join("?" for _ in fired_ids)
            conn.execute(
                f"UPDATE meta_memory SET hit_count = hit_count + 1 WHERE id IN ({ph})",
                fired_ids,
            )
            conn.commit()
    except Exception:
        pass
    return (
        "Persistent learnings about this knowledge base (apply when relevant, "
        "do not cite as evidence):\n" + "\n".join(picked)
    )


def _read_full_source(source_file: str) -> str:
    """Read full text of a source file."""
    p = Path(source_file)
    if not p.exists():
        return ""
    try:
        text = p.read_text(encoding="utf-8", errors="ignore")
        if len(text) > 50000:
            text = (
                text[:50000]
                + f"\n\n[... truncated, {len(text) - 50000} more chars ...]"
            )
        return text
    except Exception:
        return ""


@app.post("/chat")
def api_chat(req: ChatRequest) -> dict:
    """Unified AI chat — first call returns quick answer + source_files cache.
    Follow-ups with source_files get deep context from full documents."""
    start = time.time()

    # Load evidence chunks
    search_result = None
    if req.evidence_ids:
        with connect() as conn:
            placeholders = ",".join("?" for _ in req.evidence_ids)
            rows = conn.execute(
                f"SELECT id, text, source_ref, source_file, dimension FROM chunks WHERE id IN ({placeholders})",
                req.evidence_ids,
            ).fetchall()
        evidence = [dict(r) for r in rows]
    else:
        search_result = search(req.query, req.topk)
        evidence = search_result["results"]

    # A3: answer cache lookup (query + sorted evidence ids signature)
    from app.cache import lookup_answer as _cache_lookup, save_answer as _cache_save

    ev_ids_ordered = [
        int(e.get("id")) for e in evidence if isinstance(e.get("id"), int)
    ]
    cached = _cache_lookup(req.query, ev_ids_ordered)
    if cached and not req.source_files:
        # Only serve cache when NOT in deep-source follow-up mode — deep mode
        # injects the full raw doc which would need a fresh call.
        latency = int((time.time() - start) * 1000)
        return {
            "answer_id": 0,
            "answer": cached["answer"],
            "evidence": evidence,
            "latency_ms": latency,
            "source_files": [],
            "from_cache": True,
            "cache_hit_count": cached["hit_count"],
        }

    # Build evidence text for the prompt
    evidence_lines = []
    for i, e in enumerate(evidence):
        text = (e.get("text", "") or "").strip()
        ref = e.get("source_ref", "")
        if text:
            evidence_lines.append(f"[{i + 1}] ({ref}) {text}")
    evidence_text = "\n".join(evidence_lines)

    # Deep mode: if source_files provided (follow-up), inject full document content
    deep_context = ""
    if req.source_files:
        full_texts = []
        for sf in req.source_files[:3]:  # Max 3 sources
            full = _read_full_source(sf)
            if full:
                full_texts.append(f"=== {Path(sf).name} ===\n{full}")
        if full_texts:
            deep_context = (
                "\n\n以下是最相关文档的完整内容（供深度参考）:\n\n"
                + "\n\n".join(full_texts)
            )

    user_prompt = (
        f"问题: {req.query}\n\n"
        f"以下是从知识库中检索到的 {len(evidence_lines)} 条相关内容片段。\n"
        f"请综合所有片段回答问题。引用时使用 [1] [2] 等编号标注来源。\n\n"
        f"内容片段:\n{evidence_text}"
        f"{deep_context}\n\n"
        f"请直接回答问题，引用具体来源。"
    )

    messages: list[dict] = []
    for h in req.history[-6:]:
        messages.append({"role": h.role, "content": h.content})
    messages.append({"role": "user", "content": user_prompt})

    system = (
        "You are a precise knowledge assistant. "
        "Always cite evidence using [N] notation. "
        "Answer in the same language as the question. Never fabricate information not in the evidence."
    )
    if deep_context:
        system += " You have full document content available — give a thorough, deep answer citing specific sections."

    # Inject meta-memory — persistent cross-session learnings (vocab/alias/rule)
    # that disambiguate user terminology. Scoped entries only fire when the
    # query mentions them, so global-scope learnings always apply.
    mm_prelude = _meta_memory_prelude(req.query)
    if mm_prelude:
        system = mm_prelude + "\n\n" + system

    # B1: prompt caching candidate — if evidence concentrates on ONE wiki
    # topic, we load its full text into a cached prefix so follow-up questions
    # on the same topic are ~10x cheaper.
    cacheable_prefix = ""
    dim_counts: dict[str, int] = {}
    for e in evidence:
        dim = e.get("dimension") or ""
        if dim.startswith("wiki:"):
            dim_counts[dim] = dim_counts.get(dim, 0) + 1
    if dim_counts:
        top_dim, top_n = max(dim_counts.items(), key=lambda kv: kv[1])
        if top_n >= max(2, len(evidence) // 2):
            # At least half evidence agrees on one wiki topic.
            wiki_source_files = {
                e.get("source_file")
                for e in evidence
                if (e.get("dimension") or "") == top_dim
            }
            wiki_text_parts = []
            for sf in list(wiki_source_files)[:2]:
                full = _read_full_source(sf)
                if full:
                    wiki_text_parts.append(f"=== {Path(sf).name} ===\n{full}")
            if wiki_text_parts:
                cacheable_prefix = (
                    f"# Primary wiki context (topic: {top_dim[5:]})\n\n"
                    + "\n\n".join(wiki_text_parts)
                )

    try:
        answer = _chat_completion(system, messages, cacheable_prefix=cacheable_prefix)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc))

    latency = int((time.time() - start) * 1000)

    # Extract top source files for caching (deduplicated, top 3)
    seen_files: set[str] = set()
    top_source_files: list[str] = []
    for e in evidence:
        sf = e.get("source_file", "")
        if sf and sf not in seen_files and Path(sf).exists():
            seen_files.add(sf)
            top_source_files.append(sf)
            if len(top_source_files) >= 3:
                break

    evidence_ids = [e.get("id") for e in evidence if e.get("id")]

    # A2: aggregate per-path contributions across top evidence so feedback
    # can later nudge weights toward the path that actually drove this hit.
    path_breakdown_agg: dict[str, float] = {}
    count = 0
    for e in evidence[:5]:
        pb = e.get("path_breakdown") or {}
        if not pb:
            continue
        count += 1
        for k, v in pb.items():
            path_breakdown_agg[k] = path_breakdown_agg.get(k, 0.0) + float(v or 0)
    if count:
        for k in list(path_breakdown_agg.keys()):
            path_breakdown_agg[k] /= count

    # Evidence trust sum (for answer cache gating)
    trust_sum = 0.0
    try:
        if evidence_ids:
            with connect() as conn:
                ph = ",".join("?" for _ in evidence_ids)
                for r in conn.execute(
                    f"SELECT trust_score FROM chunks WHERE id IN ({ph})",
                    evidence_ids,
                ).fetchall():
                    trust_sum += float(r["trust_score"] or 0)
    except Exception:
        pass

    with connect() as conn:
        qid_row = conn.execute(
            "SELECT id FROM query_logs ORDER BY id DESC LIMIT 1"
        ).fetchone()
        qid = qid_row["id"] if qid_row else 0
        conn.execute(
            "INSERT INTO answer_logs(query_id, answer_text, evidence_refs, "
            "model_name, latency_ms, path_breakdown_json) "
            "VALUES(?, ?, ?, ?, ?, ?)",
            (
                qid,
                answer,
                json.dumps(evidence_ids),
                settings.provider_chat_model,
                latency,
                json.dumps(path_breakdown_agg, ensure_ascii=False),
            ),
        )
        answer_id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
        conn.commit()

    # A3: cache the answer if evidence is trusted
    _cache_save(
        req.query,
        ev_ids_ordered,
        answer,
        settings.provider_chat_model,
        trust_sum,
    )

    return {
        "answer_id": answer_id,
        "answer": answer,
        "evidence": evidence,
        "latency_ms": latency,
        "source_files": top_source_files,
        "prompt_cache_used": bool(cacheable_prefix),
        "path_breakdown_avg": path_breakdown_agg,
    }


# ── Stage 4: Strengthen ──


@app.post("/feedback")
def api_feedback(req: FeedbackRequest) -> dict:
    """Stage 4: Strengthen — saves Q&A memory with params, updates query profiles."""
    add_feedback(req.answer_id, req.feedback_type)

    if req.feedback_type == "plus_one" or req.feedback_type == "minus_one":
        # Strengthen the query profile (only for plus_one)
        if req.feedback_type == "plus_one" and req.query_text:
            strengthen_profile(req.query_text, boost=1.0)

        # A2: nudge this query's weights toward the path that dominated the
        # upvoted evidence (or dampen the winning path on downvote).
        try:
            from app.adaptive import adjust_weights_from_feedback as _adjust

            with connect() as conn:
                pb_row = conn.execute(
                    "SELECT path_breakdown_json FROM answer_logs WHERE id = ?",
                    (req.answer_id,),
                ).fetchone()
            if pb_row and pb_row["path_breakdown_json"] and req.query_text:
                try:
                    pb = json.loads(pb_row["path_breakdown_json"])
                except (json.JSONDecodeError, TypeError):
                    pb = {}
                sign = 1.0 if req.feedback_type == "plus_one" else -0.5
                _adjust(req.query_text, pb, sign=sign)
        except Exception:
            pass

        # Adjust trust_score on evidence chunks: +1 for plus_one, -0.5 for minus_one. Retrieval factors this in
        # so the knowledge base self-curates toward chunks that led to good
        # answers. Compounds with usage: heavily-trusted chunks surface
        # faster in subsequent searches.
        try:
            with connect() as conn:
                a_row = conn.execute(
                    "SELECT evidence_refs FROM answer_logs WHERE id = ?",
                    (req.answer_id,),
                ).fetchone()
                if a_row and a_row["evidence_refs"]:
                    ev_ids = json.loads(a_row["evidence_refs"] or "[]")
                    ev_ids = [i for i in ev_ids if isinstance(i, int)]
                    if ev_ids:
                        delta = 1.0 if req.feedback_type == "plus_one" else -0.5
                        ph = ",".join("?" for _ in ev_ids)
                        conn.execute(
                            f"UPDATE chunks SET trust_score = trust_score + ? "
                            f"WHERE id IN ({ph})",
                            (delta, *ev_ids),
                        )
                        conn.commit()
        except Exception:
            pass

    if req.feedback_type == "plus_one":
        # Save full Q&A snapshot as memory
        with connect() as conn:
            answer_row = conn.execute(
                "SELECT query_id, answer_text, evidence_refs FROM answer_logs WHERE id = ?",
                (req.answer_id,),
            ).fetchone()
            if answer_row:
                # Get the query text and evidence IDs
                query_text = req.query_text
                if not query_text and answer_row["query_id"]:
                    q_row = conn.execute(
                        "SELECT query_text FROM query_logs WHERE id = ?",
                        (answer_row["query_id"],),
                    ).fetchone()
                    if q_row:
                        query_text = q_row["query_text"]

                evidence_ids = []
                try:
                    raw_ids = json.loads(answer_row["evidence_refs"] or "[]")
                    evidence_ids = [eid for eid in raw_ids if isinstance(eid, int)]
                except (json.JSONDecodeError, TypeError):
                    pass

        # Save Q&A memory outside the connection block
        if query_text and answer_row:
            try:
                save_qa_memory(
                    query=query_text,
                    answer=answer_row["answer_text"],
                    evidence_ids=evidence_ids,
                )
            except Exception:
                pass  # Don't fail feedback if memory save fails

    return {"status": "ok"}


def _read_line_window(
    path: str | Path, center_line: int, before: int = 5, after: int = 5
) -> list[dict]:
    """Stream only the window around center_line (1-based). Does not load the full file into memory."""
    start = max(1, center_line - before)
    end = center_line + after
    out: list[dict] = []
    with Path(path).open(encoding="utf-8", errors="ignore") as f:
        for i, line in enumerate(f, start=1):
            if i < start:
                continue
            if i > end:
                break
            out.append(
                {"line": i, "text": line.rstrip("\n\r"), "highlight": i == center_line}
            )
    return out


def _read_lines_inclusive(
    path: str | Path, line_start: int, line_end: int
) -> list[dict]:
    """Lines line_start..line_end inclusive (1-based). Streaming read."""
    if line_end < line_start:
        return []
    out: list[dict] = []
    with Path(path).open(encoding="utf-8", errors="ignore") as f:
        for i, line in enumerate(f, start=1):
            if i < line_start:
                continue
            if i > line_end:
                break
            out.append({"line": i, "text": line.rstrip("\n\r")})
    return out


# ── Source preview ──


@app.get("/source")
def api_source(
    ref: str = Query(..., description="source_ref like raw.md:line:5:line"),
) -> dict:
    """Return raw file content around the referenced line for source preview."""
    parts = ref.split(":")

    # Parse line number from ref (format: filename:line:N:kind or file:line:N-M)
    line_no = 1
    for part in parts:
        try:
            # Handle "5" or "5-10" (take the first number)
            n = int(part.split("-")[0])
            if n > 0:
                line_no = n
                break
        except ValueError:
            continue

    # Find the source file path — try exact match first, then LIKE
    source_file = None
    with connect() as conn:
        row = conn.execute(
            "SELECT source_file FROM chunks WHERE source_ref = ? LIMIT 1", (ref,)
        ).fetchone()
        if row:
            source_file = row["source_file"]
        else:
            # Fuzzy match: use the filename part of the ref
            filename = parts[0] if parts else ref
            row = conn.execute(
                "SELECT source_file FROM chunks WHERE source_ref LIKE ? LIMIT 1",
                (f"{filename}%",),
            ).fetchone()
            if row:
                source_file = row["source_file"]

    # Last resort: if ref looks like an absolute path, use it directly
    if not source_file and ref.startswith("/"):
        source_file = ref.split(":")[0]

    if not source_file:
        raise HTTPException(status_code=404, detail=f"Source not found for ref: {ref}")

    if not Path(source_file).exists():
        raise HTTPException(status_code=404, detail=f"File not found: {source_file}")

    try:
        context_lines = _read_line_window(source_file, line_no)
        return {
            "file": source_file,
            "target_line": line_no,
            "lines": context_lines,
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/embed")
def api_embed(req: SearchRequest) -> dict:
    vectors = embed_texts([req.query])
    return {"vectors": vectors}


@app.get("/graph")
def api_graph() -> dict:
    return get_graph()


@app.get("/wiki-graph")
def api_wiki_graph() -> dict:
    """Return a document-level graph of wiki topics with shared keyword edges."""
    with connect() as conn:
        # Get all wiki tag_segments (one per topic)
        seg_rows = conn.execute(
            "SELECT tag, topic_name, summary, keywords_json, source_file FROM tag_segments WHERE tag LIKE 'wiki:%'"
        ).fetchall()

        # Get source files per topic
        file_rows = conn.execute(
            "SELECT dimension, source_file, COUNT(1) chunk_count FROM chunks WHERE dimension LIKE 'wiki:%' GROUP BY dimension, source_file ORDER BY dimension, source_file"
        ).fetchall()

    # Build topic nodes
    topics: dict[str, dict] = {}
    for row in seg_rows:
        topic = row["topic_name"]
        if topic in topics:
            continue
        kws = []
        try:
            kws = json.loads(row["keywords_json"]) if row["keywords_json"] else []
        except (json.JSONDecodeError, TypeError):
            pass
        topics[topic] = {
            "id": topic,
            "name": topic,
            "summary": row["summary"] or "",
            "keywords": [k.lower() for k in kws[:50] if isinstance(k, str)],
            "folder": row["source_file"] or "",
            "files": [],
            "chunk_count": 0,
        }

    # Attach source files
    for row in file_rows:
        dim = row["dimension"]
        topic = dim.replace("wiki:", "", 1)
        if topic in topics:
            topics[topic]["files"].append(
                {
                    "path": row["source_file"],
                    "chunks": row["chunk_count"],
                }
            )
            topics[topic]["chunk_count"] += row["chunk_count"]

    # ── Add user's note as a node (non-wiki tag_segments) ──
    with connect() as conn2:
        note_seg_rows = conn2.execute(
            "SELECT tag, topic_name, summary, keywords_json, source_file FROM tag_segments WHERE tag NOT LIKE 'wiki:%'"
        ).fetchall()
        note_chunk_count = conn2.execute(
            "SELECT COUNT(1) c FROM chunks WHERE dimension NOT LIKE 'wiki:%'"
        ).fetchone()["c"]
        note_file_rows = conn2.execute(
            "SELECT DISTINCT source_file, COUNT(1) chunk_count FROM chunks WHERE dimension NOT LIKE 'wiki:%' GROUP BY source_file"
        ).fetchall()

    # Collect note keywords from all note tag_segments
    note_keywords: set[str] = set()
    note_tags: list[str] = []
    for row in note_seg_rows:
        tag = row["tag"]
        if tag not in note_tags:
            note_tags.append(tag)
        try:
            kws = json.loads(row["keywords_json"]) if row["keywords_json"] else []
            note_keywords.update(
                k.lower() for k in kws if isinstance(k, str) and len(k) > 2
            )
        except (json.JSONDecodeError, TypeError):
            pass

    # Add note as a special node
    if note_chunk_count > 0:
        topics["__note__"] = {
            "id": "__note__",
            "name": "My Notes",
            "summary": f"{len(note_tags)} tags, {note_chunk_count} chunks",
            "keywords": list(note_keywords)[:100],
            "folder": "",
            "files": [
                {"path": r["source_file"], "chunks": r["chunk_count"]}
                for r in note_file_rows[:5]
            ],
            "chunk_count": note_chunk_count,
            "is_note": True,
        }

    # Build edges: semantic similarity between topic embedding centroids
    import numpy as np

    topic_list = list(topics.values())

    # Compute average embedding vector per topic (centroid)
    centroids: dict[str, np.ndarray] = {}
    with connect() as conn_emb:
        for t in topic_list:
            tid = t["id"]
            if tid == "__note__":
                # For notes, sample up to 200 chunks to keep it fast
                rows = conn_emb.execute(
                    "SELECT embedding_json FROM chunks WHERE dimension NOT LIKE 'wiki:%' AND embedding_json IS NOT NULL LIMIT 200"
                ).fetchall()
            else:
                rows = conn_emb.execute(
                    "SELECT embedding_json FROM chunks WHERE dimension = ? AND embedding_json IS NOT NULL",
                    (f"wiki:{tid}",),
                ).fetchall()
            vecs = []
            for r in rows:
                try:
                    v = json.loads(r["embedding_json"])
                    if v:
                        vecs.append(v)
                except (json.JSONDecodeError, TypeError):
                    pass
            if vecs:
                centroids[tid] = np.mean(vecs, axis=0)

    # Cosine similarity between centroids
    def _cosine(a: np.ndarray, b: np.ndarray) -> float:
        d = float(np.dot(a, b))
        n = float(np.linalg.norm(a) * np.linalg.norm(b))
        return d / n if n > 1e-9 else 0.0

    edges = []
    SIM_THRESHOLD = 0.55
    for i in range(len(topic_list)):
        id_i = topic_list[i]["id"]
        if id_i not in centroids:
            continue
        for j in range(i + 1, len(topic_list)):
            id_j = topic_list[j]["id"]
            if id_j not in centroids:
                continue
            sim = _cosine(centroids[id_i], centroids[id_j])
            if sim >= SIM_THRESHOLD:
                edges.append(
                    {
                        "source": id_i,
                        "target": id_j,
                        "similarity": round(sim, 3),
                        "weight": round(sim * 10, 1),
                    }
                )

    # Clean up keywords from response
    nodes = []
    for t in topic_list:
        node = {
            "id": t["id"],
            "name": t["name"],
            "summary": t["summary"],
            "folder": t["folder"],
            "files": t["files"],
            "chunk_count": t["chunk_count"],
        }
        if t.get("is_note"):
            node["is_note"] = True
        nodes.append(node)

    return {"nodes": nodes, "edges": edges}


# ── Version management ──


class RestoreRequest(BaseModel):
    version_id: str
    note_path: str


@app.get("/versions")
def api_versions() -> dict:
    return {"versions": list_versions()}


@app.post("/versions/snapshot")
def api_snapshot(note_path: str = "") -> dict:
    meta = create_snapshot(note_path, reason="manual")
    return meta


class DeleteVersionRequest(BaseModel):
    version_id: str


@app.delete("/versions/{version_id}")
def api_delete_version(version_id: str) -> dict:
    try:
        return delete_version(version_id)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))


@app.post("/versions/restore")
def api_restore(req: RestoreRequest) -> dict:
    try:
        result = restore_version(req.version_id, req.note_path)
        return result
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))


# ── Rewrite (lossless reorganization) ──


class RewriteRequest(BaseModel):
    raw_path: str
    note_path: str


class RewriteApproveRequest(BaseModel):
    candidate_id: int


@app.post("/rewrite/generate")
def api_rewrite_generate(req: RewriteRequest) -> dict:
    """Generate a lossless reorganized candidate from the raw file."""
    try:
        return generate_candidate(req.raw_path, req.note_path)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/rewrite/status")
def api_rewrite_status() -> dict:
    """Get the status of the active rewrite candidate."""
    status = get_candidate_status()
    if not status:
        return {"active": False}
    return {"active": True, **status}


@app.post("/rewrite/approve")
def api_rewrite_approve(req: RewriteApproveRequest) -> dict:
    try:
        return approve_candidate(req.candidate_id)
    except (ValueError, FileNotFoundError) as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/rewrite/reject")
def api_rewrite_reject(req: RewriteApproveRequest) -> dict:
    return reject_candidate(req.candidate_id)


# ── Tags ──

# ── Builds ──


class BuildActivateRequest(BaseModel):
    build_id: str


@app.get("/builds")
def api_builds() -> dict:
    return {"builds": list_builds()}


@app.post("/builds/activate")
def api_build_activate(req: BuildActivateRequest) -> dict:
    activate_build(req.build_id)
    return {"active": req.build_id}


@app.delete("/builds/{build_id}")
def api_build_delete(build_id: str) -> dict:
    delete_build(build_id)
    return {"deleted": build_id}


# ── User Prefs (read by MCP server to find active note path) ──


@app.get("/prefs")
def api_prefs() -> dict:
    """Return stored user preferences (raw note path, etc.)."""
    prefs_file = Path(settings.db_path).resolve().parent / "prefs.json"
    if prefs_file.exists():
        import json as _json

        try:
            return _json.loads(prefs_file.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {}


# ── Raw Note Ingest (via API) ──


class IngestRequest(BaseModel):
    raw_path: str
    note_path: str
    reset: bool = False
    # When true, skip provider-side ai_enrich entirely. Used by MCP-triggered
    # ingests so Claude (or another caller) can classify segments afterwards
    # via POST /tag-segments/classify instead of burning DeepSeek tokens.
    ai_delegate: bool = False


@app.post("/ingest")
def api_ingest(req: IngestRequest) -> dict:
    """Ingest raw notes — incremental (default) or full rebuild."""
    from app.ingest import ingest_raw

    try:
        result = ingest_raw(
            req.raw_path, req.note_path, reset=req.reset, ai_delegate=req.ai_delegate
        )
        if req.ai_delegate:
            result = {**result, "ai_delegated": True, "source_file": req.raw_path}
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ── Delegated classification (called by MCP caller after ai_delegate ingest) ──


class ClassifySegmentRequest(BaseModel):
    source_file: str
    line_start: int
    line_end: int
    tag: str
    topic_name: str = ""
    summary: str = ""
    keywords: list[str] = []
    entities: list[dict] = []
    secondary_tags: list[str] = []
    is_credential: bool = False


@app.post("/tag-segments/classify")
def api_classify_segment(req: ClassifySegmentRequest) -> dict:
    """Record a classification for an already-ingested line range.

    Intended for MCP callers (Claude) who run ingest with ai_delegate=True and
    then classify the resulting "others"-tagged content in their own context.
    Inserts a tag_segment row and updates chunks' dimension within the range.
    """
    if req.line_end < req.line_start:
        raise HTTPException(status_code=400, detail="line_end must be >= line_start")
    if not req.tag.strip():
        raise HTTPException(status_code=400, detail="tag is required")

    from app.tags import get_all_tags

    _known_tags: set[str] = set(get_all_tags())
    active = get_active_build_id() or ""
    tag = req.tag.strip()
    if tag not in _known_tags:
        tag = "others"
    affected_chunks = 0
    with connect() as conn:
        conn.execute(
            """
            INSERT INTO tag_segments(build_id, source_file, tag, topic_name, line_start, line_end, summary, keywords_json, entities_json, is_credential)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                active,
                req.source_file,
                tag,
                req.topic_name or "",
                req.line_start,
                req.line_end,
                req.summary or "",
                json.dumps(req.keywords, ensure_ascii=False),
                json.dumps(req.entities, ensure_ascii=False),
                1 if req.is_credential else 0,
            ),
        )
        for stag in req.secondary_tags or []:
            st = (stag or "").strip()
            if not st or st == tag or st not in _known_tags:
                continue
            conn.execute(
                """
                INSERT INTO tag_segments(build_id, source_file, tag, topic_name, line_start, line_end, summary, keywords_json, entities_json, is_credential)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    active,
                    req.source_file,
                    st,
                    req.topic_name or "",
                    req.line_start,
                    req.line_end,
                    req.summary or "",
                    json.dumps(req.keywords, ensure_ascii=False),
                    json.dumps(req.entities, ensure_ascii=False),
                    1 if req.is_credential else 0,
                ),
            )
        # Retag chunks whose source_ref line falls inside the range.
        rows = conn.execute(
            "SELECT id, source_ref FROM chunks WHERE source_file = ? AND (dimension = 'others' OR dimension = '' OR dimension IS NULL)",
            (req.source_file,),
        ).fetchall()
        for row in rows:
            ref = row["source_ref"] or ""
            # Refs look like "foo.md:line:42:kind"
            line_no = None
            for part in ref.split(":"):
                try:
                    n = int(part.split("-")[0])
                    if n > 0:
                        line_no = n
                        break
                except ValueError:
                    continue
            if line_no is None:
                continue
            if req.line_start <= line_no <= req.line_end:
                conn.execute(
                    "UPDATE chunks SET dimension = ? WHERE id = ?", (tag, row["id"])
                )
                affected_chunks += 1
        conn.commit()

    return {
        "ok": True,
        "tag": tag,
        "line_start": req.line_start,
        "line_end": req.line_end,
        "chunks_retagged": affected_chunks,
    }


# ── Enrichment queue (delegate mode) ──
#
# When an ingest runs with ai_delegate=True, the backend creates placeholder
# records without LLM-generated content (tag segments, chunk summaries, topic
# summaries, or re-formatted markdown). An MCP caller (typically Claude)
# discovers these via GET /enrich-queue and fills them in via POST /enrich-bulk.
#
# Kinds of pending enrichment:
#   - note_segments: a raw note file ingested with ai_delegate — chunks have
#     empty `dimension`, need tag_segments written.
#   - wiki_chunks:   wiki chunks with empty ai_summary.
#   - wiki_topic:    wiki tag_segments with empty summary.
#   - doc_format:    raw docs parked in pending_format_docs awaiting markdown
#     rewrite (triggers downstream wiki ingest on submit).


@app.get("/enrich-queue")
def api_enrich_queue(
    kind: str = Query(
        "summary",
        description="summary | note_segments | wiki_chunks | wiki_topic | doc_format",
    ),
    build_id: str = Query("", description="Filter to a specific build"),
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
) -> dict:
    with connect() as conn:
        if kind == "summary":
            # Pending builds by kind
            note_rows = conn.execute(
                "SELECT id, source_file, chunk_count FROM builds "
                "WHERE enrich_status = 'awaiting_enrich' AND source_file NOT LIKE 'wiki:%' "
                "ORDER BY created_at DESC"
            ).fetchall()
            wiki_rows = conn.execute(
                "SELECT id, source_file, chunk_count FROM builds "
                "WHERE enrich_status = 'awaiting_enrich' AND source_file LIKE 'wiki:%' "
                "ORDER BY created_at DESC"
            ).fetchall()
            wiki_chunks_pending = conn.execute(
                "SELECT COUNT(1) c FROM chunks "
                "WHERE dimension LIKE 'wiki:%' AND (ai_summary IS NULL OR ai_summary = '')"
            ).fetchone()["c"]
            wiki_topic_pending = conn.execute(
                "SELECT COUNT(1) c FROM tag_segments "
                "WHERE tag LIKE 'wiki:%' AND (summary IS NULL OR summary = '')"
            ).fetchone()["c"]
            doc_format_pending = conn.execute(
                "SELECT COUNT(1) c FROM pending_format_docs WHERE status = 'awaiting'"
            ).fetchone()["c"]
            return {
                "kind": "summary",
                "note_segments": {
                    "pending_builds": len(note_rows),
                    "builds": [
                        {
                            "build_id": r["id"],
                            "source_file": r["source_file"],
                            "chunks": r["chunk_count"],
                        }
                        for r in note_rows
                    ],
                },
                "wiki_chunks": {
                    "pending_chunks": int(wiki_chunks_pending or 0),
                    "builds": [
                        {
                            "build_id": r["id"],
                            "topic": (r["source_file"] or "").replace("wiki:", "", 1),
                        }
                        for r in wiki_rows
                    ],
                },
                "wiki_topic": {
                    "pending_topics": int(wiki_topic_pending or 0),
                },
                "doc_format": {
                    "pending_docs": int(doc_format_pending or 0),
                },
            }

        if kind == "note_segments":
            q = (
                "SELECT id, source_file, chunk_count FROM builds "
                "WHERE enrich_status = 'awaiting_enrich' AND source_file NOT LIKE 'wiki:%'"
            )
            params: list = []
            if build_id:
                q += " AND id = ?"
                params.append(build_id)
            q += " ORDER BY created_at DESC LIMIT ? OFFSET ?"
            params.extend([limit, offset])
            rows = conn.execute(q, params).fetchall()
            builds = []
            for r in rows:
                sf = r["source_file"]
                total_lines = 0
                try:
                    p = Path(sf)
                    if p.exists():
                        with p.open("rb") as fh:
                            total_lines = sum(1 for _ in fh)
                except Exception:
                    pass

                # Existing segments on this build (so Claude can preserve them
                # on incremental ingests and only classify pending ranges).
                seg_rows = conn.execute(
                    "SELECT line_start, line_end, tag, topic_name, summary "
                    "FROM tag_segments WHERE build_id = ? AND source_file = ? "
                    "ORDER BY line_start, line_end",
                    (r["id"], sf),
                ).fetchall()
                existing_segments = [
                    {
                        "line_start": s["line_start"],
                        "line_end": s["line_end"],
                        "tag": s["tag"],
                        "topic_name": s["topic_name"],
                        "summary": s["summary"],
                    }
                    for s in seg_rows
                ]

                # Pending line ranges: chunks with empty dimension, their
                # source_ref line numbers coalesced into contiguous ranges.
                pending_rows = conn.execute(
                    "SELECT source_ref FROM chunks "
                    "WHERE build_id = ? AND source_file = ? "
                    "AND (dimension = '' OR dimension IS NULL) "
                    "ORDER BY id",
                    (r["id"], sf),
                ).fetchall()
                line_nums: list[int] = []
                for cr in pending_rows:
                    ref = cr["source_ref"] or ""
                    for part in ref.split(":"):
                        try:
                            n = int(part.split("-")[0])
                            if n > 0:
                                line_nums.append(n)
                                break
                        except ValueError:
                            continue
                line_nums.sort()
                dedup: list[int] = []
                last = -1
                for n in line_nums:
                    if n != last:
                        dedup.append(n)
                        last = n
                # Coalesce into ranges (gap <= 2 lines counts as same range).
                pending_ranges: list[dict] = []
                if dedup:
                    rs = re = dedup[0]
                    for n in dedup[1:]:
                        if n - re <= 2:
                            re = n
                        else:
                            pending_ranges.append({"line_start": rs, "line_end": re})
                            rs = re = n
                    pending_ranges.append({"line_start": rs, "line_end": re})

                incremental = len(existing_segments) > 0

                # Suggested partitions for parallel subagent enrichment.
                # Each partition is a roughly equal slice of pending lines
                # (~1500 lines each, max 8 partitions). Empty when only a
                # small amount is pending — no point spinning up subagents.
                total_pending_lines = sum(
                    pr["line_end"] - pr["line_start"] + 1 for pr in pending_ranges
                )
                suggested_partitions: list[dict] = []
                if total_pending_lines >= 3000 and pending_ranges:
                    target = min(8, max(2, total_pending_lines // 1500))
                    slice_size = max(1, total_pending_lines // target)
                    # Walk pending_ranges, accumulate lines into slots.
                    buf_start: int | None = None
                    buf_end: int = 0
                    buf_lines: int = 0
                    for pr in pending_ranges:
                        s, e = pr["line_start"], pr["line_end"]
                        if buf_start is None:
                            buf_start, buf_end, buf_lines = s, e, e - s + 1
                        else:
                            buf_end = e
                            buf_lines += e - s + 1
                        if buf_lines >= slice_size:
                            suggested_partitions.append(
                                {
                                    "line_start": buf_start,
                                    "line_end": buf_end,
                                    "approx_lines": buf_lines,
                                }
                            )
                            buf_start = None
                            buf_lines = 0
                    if buf_start is not None:
                        suggested_partitions.append(
                            {
                                "line_start": buf_start,
                                "line_end": buf_end,
                                "approx_lines": buf_lines,
                            }
                        )

                hint = (
                    "Incremental enrich: only classify the lines in `pending_line_ranges`. "
                    "Existing segments in `existing_segments` are preserved — don't re-emit them. "
                    if incremental
                    else "Read the source_file, decide semantic segments for the whole file. "
                ) + (
                    "Submit via submit_enrichments(kind='note_segments', items=[...]) "
                    "or items_file=<absolute path> for large batches. "
                )
                if suggested_partitions:
                    hint += (
                        f"For speed, spawn {len(suggested_partitions)} subagents — one per "
                        "partition in `suggested_partitions` — each writes its JSONL to "
                        "/tmp/seg-<idx>.jsonl, then merge and submit with items_file."
                    )

                builds.append(
                    {
                        "build_id": r["id"],
                        "source_file": sf,
                        "chunks": r["chunk_count"],
                        "total_lines": total_lines,
                        "existing_segments": existing_segments,
                        "pending_line_ranges": pending_ranges,
                        "pending_chunk_count": len(pending_rows),
                        "incremental": incremental,
                        "suggested_partitions": suggested_partitions,
                        "hint": hint,
                    }
                )
            return {"kind": "note_segments", "builds": builds}

        if kind == "wiki_chunks":
            q_where = "c.dimension LIKE 'wiki:%' AND (c.ai_summary IS NULL OR c.ai_summary = '')"
            params = []
            if build_id:
                q_where += " AND c.build_id = ?"
                params.append(build_id)
            rows = conn.execute(
                f"SELECT c.id, c.build_id, c.source_file, c.source_ref, c.text, c.dimension "
                f"FROM chunks c WHERE {q_where} "
                f"ORDER BY c.build_id, c.id LIMIT ? OFFSET ?",
                (*params, limit, offset),
            ).fetchall()
            total_row = conn.execute(
                f"SELECT COUNT(1) c FROM chunks c WHERE {q_where}", params
            ).fetchone()
            chunks = [
                {
                    "chunk_id": r["id"],
                    "build_id": r["build_id"],
                    "topic": (r["dimension"] or "").replace("wiki:", "", 1),
                    "source_file": r["source_file"],
                    "source_ref": r["source_ref"],
                    "text": r["text"],
                }
                for r in rows
            ]
            return {
                "kind": "wiki_chunks",
                "total": int(total_row["c"] or 0),
                "returned": len(chunks),
                "offset": offset,
                "limit": limit,
                "chunks": chunks,
                "hint": (
                    "Each chunk needs a summary (1 sentence, <30 words), keywords (3-6), "
                    "and entities ([{name, type}]). Submit via submit_enrichments("
                    "kind='wiki_chunks', items=[{chunk_id, summary, keywords, entities}])."
                ),
            }

        if kind == "wiki_topic":
            q = (
                "SELECT id, build_id, tag, topic_name, source_file, keywords_json "
                "FROM tag_segments WHERE tag LIKE 'wiki:%' AND (summary IS NULL OR summary = '')"
            )
            params = []
            if build_id:
                q += " AND build_id = ?"
                params.append(build_id)
            q += " ORDER BY created_at DESC LIMIT ? OFFSET ?"
            params.extend([limit, offset])
            rows = conn.execute(q, params).fetchall()
            topics = []
            for r in rows:
                # Gather already-enriched chunk summaries as context hints
                chunk_hints = conn.execute(
                    "SELECT source_ref, ai_summary FROM chunks "
                    "WHERE dimension = ? AND ai_summary != '' LIMIT 20",
                    (r["tag"],),
                ).fetchall()
                topics.append(
                    {
                        "tag_segment_id": r["id"],
                        "build_id": r["build_id"],
                        "topic_name": r["topic_name"],
                        "source_file": r["source_file"],
                        "chunk_summary_samples": [
                            {"source_ref": h["source_ref"], "summary": h["ai_summary"]}
                            for h in chunk_hints
                        ],
                        "structural_keywords": (
                            json.loads(r["keywords_json"]) if r["keywords_json"] else []
                        )[:30],
                    }
                )
            return {
                "kind": "wiki_topic",
                "topics": topics,
                "hint": (
                    "Use chunk_summary_samples as context. Produce a 2-3 sentence "
                    "topic-level summary. Submit via submit_enrichments("
                    "kind='wiki_topic', items=[{tag_segment_id, summary, keywords}])."
                ),
            }

        if kind == "doc_format":
            rows = conn.execute(
                "SELECT id, format_id, topic_name, title, raw_content, source, target_dir "
                "FROM pending_format_docs WHERE status = 'awaiting' "
                "ORDER BY created_at DESC LIMIT ? OFFSET ?",
                (limit, offset),
            ).fetchall()
            docs = [
                {
                    "format_id": r["format_id"],
                    "topic_name": r["topic_name"],
                    "title": r["title"],
                    "raw_content": r["raw_content"],
                    "source": r["source"],
                    "target_dir": r["target_dir"],
                }
                for r in rows
            ]
            return {
                "kind": "doc_format",
                "docs": docs,
                "hint": (
                    "Rewrite raw_content into clean, well-structured Markdown — "
                    "preserve all content, add proper headings/lists/tables, keep the "
                    "original language. Submit via submit_enrichments("
                    "kind='doc_format', items=[{format_id, markdown}]). This triggers a "
                    "delegated wiki ingest (expect wiki_chunks + wiki_topic to become pending)."
                ),
            }

        raise HTTPException(status_code=400, detail=f"Unknown kind: {kind}")


class EnrichBulkRequest(BaseModel):
    kind: str
    items: list[dict] = []
    # Optional: absolute path to a file containing items. Supports .json (a
    # JSON array) or .jsonl (one JSON object per line). Reading from disk
    # avoids the overhead of the MCP caller (e.g. Claude) generating a huge
    # JSON payload token-by-token for large batches.
    items_file: str = ""
    # Self-reported name of the AI/tool that produced this enrichment.
    # Examples: "claude-code", "cursor", "opencode", "gemini-cli".
    # Written to builds.completed_by as "mcp:<enriched_by>" so the UI can
    # display which agent did the work. Defaults to "delegate" (generic).
    enriched_by: str = "delegate"


@app.post("/enrich-bulk")
def api_enrich_bulk(req: EnrichBulkRequest) -> dict:
    """Apply a batch of enrichments produced by an MCP caller (e.g. Claude).

    See GET /enrich-queue for the item shape per kind.
    """
    from app.builds import recompute_enrich_status
    from app.events import publish as _publish

    kind = (req.kind or "").strip()
    items = list(req.items or [])
    # Optionally hydrate items from a local file (avoids the caller emitting
    # a huge JSON payload). JSONL is streamed line-by-line; .json expects a
    # top-level array.
    if req.items_file:
        p = Path(req.items_file)
        if not p.exists():
            raise HTTPException(
                status_code=400, detail=f"items_file not found: {req.items_file}"
            )
        try:
            if p.suffix.lower() == ".jsonl":
                with p.open(encoding="utf-8") as fh:
                    for idx, line in enumerate(fh, start=1):
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            items.append(json.loads(line))
                        except json.JSONDecodeError as e:
                            raise HTTPException(
                                status_code=400,
                                detail=f"items_file parse error at line {idx}: {e}",
                            )
            else:
                parsed = json.loads(p.read_text(encoding="utf-8"))
                if not isinstance(parsed, list):
                    raise HTTPException(
                        status_code=400, detail="items_file must be a JSON array"
                    )
                items.extend(parsed)
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"items_file read error: {e}")
    if not items:
        return {"kind": kind, "applied": 0, "failed": []}

    # Broadcast enrich progress over SSE so the desktop pipeline lights up when
    # Claude is doing the work (same channel as ingest). Channel is 'note' for
    # note_segments; 'wiki' for wiki_chunks / wiki_topic / doc_format.
    sse_channel = "note" if kind == "note_segments" else "wiki"
    total_items = len(items)

    def _emit(step: str, current: int, detail: str) -> None:
        try:
            _publish(
                {
                    "channel": sse_channel,
                    "step": step,
                    "current": current,
                    "total": total_items,
                    "detail": detail,
                    "actor": "mcp:delegate",
                    "kind": kind,
                }
            )
        except Exception:
            pass

    _emit("ai_enrich", 0, f"Claude submitting {total_items} {kind}...")

    applied = 0
    failed: list[dict] = []
    touched_builds: set[str] = set()

    conflicts_created: list[dict] = []

    if kind == "note_segments":
        from app.tags import get_all_tags

        _known_tags: set[str] = set(get_all_tags())
        active = get_active_build_id() or ""
        with connect() as conn:
            for idx, it in enumerate(items):
                try:
                    source_file = it["source_file"]
                    line_start = int(it["line_start"])
                    line_end = int(it["line_end"])
                    tag = (it.get("tag") or "").strip()
                    if not tag or line_end < line_start:
                        raise ValueError("tag + line_start<=line_end required")
                    # Reject unknown tags — AI must only use existing tags.
                    if tag not in _known_tags:
                        tag = "others"

                    # Resolve the build_id for this submission (most recent
                    # chunk for this file) — needed both for conflict scope
                    # and for inserting the tag_segment under the right build.
                    b_row = conn.execute(
                        "SELECT build_id FROM chunks WHERE source_file = ? ORDER BY id DESC LIMIT 1",
                        (source_file,),
                    ).fetchone()
                    build_id = (b_row["build_id"] if b_row else "") or active

                    # C1: conflict detection — scoped to the CURRENT build.
                    # Cross-build conflicts are irrelevant: old builds are
                    # read-only history; only within-build overlaps of a
                    # different tag indicate a real ambiguity.
                    overlap = conn.execute(
                        "SELECT id, tag, topic_name, build_id, line_start, line_end "
                        "FROM tag_segments "
                        "WHERE source_file = ? AND build_id = ? "
                        "AND line_start <= ? AND line_end >= ? "
                        "AND tag != ? AND tag NOT LIKE 'wiki:%' "
                        "LIMIT 1",
                        (source_file, build_id, line_end, line_start, tag),
                    ).fetchone()
                    if overlap:
                        conn.execute(
                            "INSERT INTO conflict_pending("
                            "build_id, source_file, line_start, line_end, "
                            "existing_tag, existing_topic, incoming_tag, "
                            "incoming_topic, incoming_summary, incoming_payload_json) "
                            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                            (
                                build_id,
                                source_file,
                                line_start,
                                line_end,
                                overlap["tag"],
                                overlap["topic_name"] or "",
                                tag,
                                it.get("topic_name", "") or "",
                                it.get("summary", "") or "",
                                json.dumps(it, ensure_ascii=False),
                            ),
                        )
                        conflicts_created.append(
                            {
                                "line_start": line_start,
                                "line_end": line_end,
                                "existing_tag": overlap["tag"],
                                "incoming_tag": tag,
                            }
                        )
                        conn.commit()
                        # Skip applying — wait for human resolution
                        continue
                    kws = it.get("keywords") or []
                    ents = it.get("entities") or []
                    conn.execute(
                        """
                        INSERT INTO tag_segments(build_id, source_file, tag, topic_name, line_start, line_end, summary, keywords_json, entities_json, is_credential)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            build_id,
                            source_file,
                            tag,
                            it.get("topic_name", "") or "",
                            line_start,
                            line_end,
                            it.get("summary", "") or "",
                            json.dumps(kws, ensure_ascii=False),
                            json.dumps(ents, ensure_ascii=False),
                            1 if it.get("is_credential") else 0,
                        ),
                    )
                    for stag in it.get("secondary_tags") or []:
                        st = (stag or "").strip()
                        if not st or st == tag or st not in _known_tags:
                            continue
                        conn.execute(
                            """
                            INSERT INTO tag_segments(build_id, source_file, tag, topic_name, line_start, line_end, summary, keywords_json, entities_json, is_credential)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                            """,
                            (
                                build_id,
                                source_file,
                                st,
                                it.get("topic_name", "") or "",
                                line_start,
                                line_end,
                                it.get("summary", "") or "",
                                json.dumps(kws, ensure_ascii=False),
                                json.dumps(ents, ensure_ascii=False),
                                1 if it.get("is_credential") else 0,
                            ),
                        )
                    # Retag chunks falling inside the range (pending ones only)
                    chunk_rows = conn.execute(
                        "SELECT id, source_ref FROM chunks WHERE source_file = ? "
                        "AND (dimension = '' OR dimension IS NULL OR dimension = 'others')",
                        (source_file,),
                    ).fetchall()
                    for cr in chunk_rows:
                        ref = cr["source_ref"] or ""
                        line_no = None
                        for part in ref.split(":"):
                            try:
                                n = int(part.split("-")[0])
                                if n > 0:
                                    line_no = n
                                    break
                            except ValueError:
                                continue
                        if line_no is not None and line_start <= line_no <= line_end:
                            conn.execute(
                                "UPDATE chunks SET dimension = ? WHERE id = ?",
                                (tag, cr["id"]),
                            )
                    if build_id:
                        touched_builds.add(build_id)
                    applied += 1
                except Exception as e:
                    failed.append({"index": idx, "error": str(e)})
            conn.commit()

    elif kind == "wiki_chunks":
        with connect() as conn:
            for idx, it in enumerate(items):
                try:
                    chunk_id = int(it["chunk_id"])
                    summary = (it.get("summary") or "").strip()
                    if not summary:
                        raise ValueError("summary required")
                    kws = it.get("keywords") or []
                    ents = it.get("entities") or []
                    # Merge kws into existing keywords_json
                    row = conn.execute(
                        "SELECT build_id, keywords_json FROM chunks WHERE id = ?",
                        (chunk_id,),
                    ).fetchone()
                    if not row:
                        raise ValueError(f"chunk {chunk_id} not found")
                    try:
                        existing_kws = (
                            json.loads(row["keywords_json"])
                            if row["keywords_json"]
                            else []
                        )
                    except (json.JSONDecodeError, TypeError):
                        existing_kws = []
                    merged = list(
                        {(k or "").lower() for k in (*existing_kws, *kws) if k}
                    )
                    conn.execute(
                        "UPDATE chunks SET ai_summary = ?, keywords_json = ?, entities_json = ? WHERE id = ?",
                        (
                            summary,
                            json.dumps(merged, ensure_ascii=False),
                            json.dumps(ents, ensure_ascii=False),
                            chunk_id,
                        ),
                    )
                    if row["build_id"]:
                        touched_builds.add(row["build_id"])
                    applied += 1
                except Exception as e:
                    failed.append({"index": idx, "error": str(e)})
            conn.commit()

    elif kind == "wiki_topic":
        with connect() as conn:
            for idx, it in enumerate(items):
                try:
                    seg_id = int(it["tag_segment_id"])
                    summary = (it.get("summary") or "").strip()
                    if not summary:
                        raise ValueError("summary required")
                    kws = it.get("keywords") or []
                    row = conn.execute(
                        "SELECT build_id, keywords_json FROM tag_segments WHERE id = ?",
                        (seg_id,),
                    ).fetchone()
                    if not row:
                        raise ValueError(f"tag_segment {seg_id} not found")
                    try:
                        existing_kws = (
                            json.loads(row["keywords_json"])
                            if row["keywords_json"]
                            else []
                        )
                    except (json.JSONDecodeError, TypeError):
                        existing_kws = []
                    # Preserve existing structural kws; prepend new LLM kws
                    merged = list(dict.fromkeys([*(kws or []), *(existing_kws or [])]))
                    conn.execute(
                        "UPDATE tag_segments SET summary = ?, keywords_json = ? WHERE id = ?",
                        (summary, json.dumps(merged[:300], ensure_ascii=False), seg_id),
                    )
                    if row["build_id"]:
                        touched_builds.add(row["build_id"])
                    applied += 1
                except Exception as e:
                    failed.append({"index": idx, "error": str(e)})
            conn.commit()

    elif kind == "doc_format":
        from app.special_ingest import ingest_folder

        chained: list[dict] = []
        with connect() as conn:
            for idx, it in enumerate(items):
                try:
                    format_id = it["format_id"]
                    markdown = (it.get("markdown") or "").strip()
                    if not markdown:
                        raise ValueError("markdown required")
                    row = conn.execute(
                        "SELECT topic_name, target_dir FROM pending_format_docs "
                        "WHERE format_id = ? AND status = 'awaiting'",
                        (format_id,),
                    ).fetchone()
                    if not row:
                        raise ValueError(
                            f"format_id {format_id} not found or already done"
                        )
                    target_dir = Path(row["target_dir"])
                    target_dir.mkdir(parents=True, exist_ok=True)
                    import re as _re

                    safe_name = _re.sub(
                        r"[^\w\s\u4e00-\u9fff-]", "_", row["topic_name"]
                    )[:80]
                    md_path = target_dir / f"{safe_name}.md"
                    md_path.write_text(markdown, encoding="utf-8")
                    conn.execute(
                        "UPDATE pending_format_docs SET status = 'completed' WHERE format_id = ?",
                        (format_id,),
                    )
                    conn.commit()
                    # Chain into delegated wiki ingest (creates wiki_chunks + wiki_topic pending)
                    try:
                        ing = ingest_folder(
                            str(target_dir),
                            topic_name=row["topic_name"],
                            ai_delegate=True,
                        )
                        chained.append({"format_id": format_id, **ing})
                        if ing.get("build_id"):
                            touched_builds.add(ing["build_id"])
                    except Exception as ie:
                        chained.append(
                            {"format_id": format_id, "ingest_error": str(ie)}
                        )
                    applied += 1
                except Exception as e:
                    failed.append({"index": idx, "error": str(e)})
        _emit(
            "ai_enrich",
            applied,
            f"Applied {applied}/{total_items} doc_format (chained ingests: {len(chained)})",
        )
        _emit(
            "done",
            applied,
            f"Claude completed doc_format: {applied} applied, {len(chained)} wiki ingests triggered",
        )
        return {
            "kind": kind,
            "applied": applied,
            "failed": failed,
            "chained_ingests": chained,
        }

    else:
        raise HTTPException(status_code=400, detail=f"Unknown kind: {kind}")

    _emit("ai_enrich", applied, f"Applied {applied}/{total_items} {kind}")

    # After note_segments submissions, consolidate adjacent same-tag segments
    # AND refresh segment centroids so the next incremental auto_inherit
    # benefits from what Claude just classified.
    merged_total = 0
    if kind == "note_segments" and applied > 0 and touched_builds:
        try:
            from app.autoclassify import (
                merge_adjacent_segments as _merge,
                refresh_segment_centroids as _refresh,
            )

            for bid in touched_builds:
                r = _merge(bid)
                merged_total += int(r.get("merged", 0) or 0)
                _refresh(bid)
        except Exception:
            pass

    # Recompute enrich_status for all touched builds
    enriched_by = (
        getattr(req, "enriched_by", None) or "delegate"
    ).strip() or "delegate"
    build_status: dict[str, str] = {}
    for bid in touched_builds:
        try:
            build_status[bid] = recompute_enrich_status(bid, enriched_by=enriched_by)
        except Exception:
            pass

    all_done = bool(build_status) and all(
        v == "completed" for v in build_status.values()
    )
    if all_done:
        _emit("done", applied, f"{enriched_by} completed {kind}: {applied} applied")
    return {
        "kind": kind,
        "applied": applied,
        "failed": failed,
        "merged_adjacent": merged_total,
        "conflicts_parked": conflicts_created,
        "build_status_after": build_status,
    }


# ── Conflicts, split suggestions, dashboard, streaming chat ──


@app.post("/ocr/process")
def api_ocr_process(limit: int = Query(20, ge=1, le=100)) -> dict:
    """C4: drain pending OCR queue (best-effort — requires local tesseract)."""
    from app.ocr import process_pending_ocr

    return process_pending_ocr(limit=limit)


@app.get("/ocr/pending")
def api_ocr_pending_list(limit: int = Query(50, ge=1, le=500)) -> dict:
    with connect() as conn:
        rows = conn.execute(
            "SELECT id, source_file, line_no, image_ref, status, "
            "extracted_text, created_at, processed_at "
            "FROM ocr_pending ORDER BY created_at DESC LIMIT ?",
            (limit,),
        ).fetchall()
    return {"pending": [dict(r) for r in rows]}


@app.get("/conflicts")
def api_conflicts_list(status: str = Query("pending")) -> dict:
    """C1: unresolved enrichment conflicts awaiting human choice."""
    with connect() as conn:
        rows = conn.execute(
            "SELECT id, build_id, source_file, line_start, line_end, "
            "existing_tag, existing_topic, incoming_tag, incoming_topic, "
            "incoming_summary, status, created_at "
            "FROM conflict_pending WHERE status = ? ORDER BY created_at DESC",
            (status,),
        ).fetchall()
    return {"conflicts": [dict(r) for r in rows]}


class ConflictResolveRequest(BaseModel):
    conflict_id: int
    choice: str  # 'keep_existing' | 'accept_incoming' | 'dismiss'


@app.post("/conflicts/resolve")
def api_conflict_resolve(req: ConflictResolveRequest) -> dict:
    with connect() as conn:
        row = conn.execute(
            "SELECT * FROM conflict_pending WHERE id = ?", (req.conflict_id,)
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="conflict not found")
        if req.choice == "accept_incoming":
            # Overwrite: drop existing segment covering range + re-insert incoming
            conn.execute(
                "DELETE FROM tag_segments WHERE source_file = ? "
                "AND line_start = ? AND line_end = ? AND tag = ?",
                (
                    row["source_file"],
                    row["line_start"],
                    row["line_end"],
                    row["existing_tag"],
                ),
            )
            try:
                payload = json.loads(row["incoming_payload_json"] or "{}")
            except (json.JSONDecodeError, TypeError):
                payload = {}
            conn.execute(
                "INSERT INTO tag_segments(build_id, source_file, tag, topic_name, "
                "line_start, line_end, summary, keywords_json, entities_json, is_credential) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    row["build_id"],
                    row["source_file"],
                    row["incoming_tag"],
                    row["incoming_topic"] or "",
                    row["line_start"],
                    row["line_end"],
                    row["incoming_summary"] or "",
                    json.dumps(payload.get("keywords", []), ensure_ascii=False),
                    json.dumps(payload.get("entities", []), ensure_ascii=False),
                    1 if payload.get("is_credential") else 0,
                ),
            )
        conn.execute(
            "UPDATE conflict_pending SET status = ? WHERE id = ?",
            (req.choice, req.conflict_id),
        )
        conn.commit()
    return {"resolved": req.conflict_id, "choice": req.choice}


@app.get("/segments/split-suggestions")
def api_split_suggestions(
    min_lines: int = Query(200, ge=50),
    min_subheadings: int = Query(3, ge=2),
) -> dict:
    """C2: segments likely to benefit from splitting — too large AND contain
    multiple sub-headings in the raw text. Scans each source_file ONCE.
    """
    with connect() as conn:
        rows = conn.execute(
            "SELECT id, build_id, source_file, tag, topic_name, line_start, line_end, summary "
            "FROM tag_segments WHERE (line_end - line_start + 1) >= ? "
            "AND tag NOT LIKE 'wiki:%'",
            (min_lines,),
        ).fetchall()
    # Group candidates by source_file so we read each file exactly once.
    by_file: dict[str, list] = {}
    for r in rows:
        by_file.setdefault(r["source_file"], []).append(r)
    suggestions: list[dict] = []
    for sf, segs in by_file.items():
        try:
            p = Path(sf)
            if not p.exists():
                continue
            # Collect ALL heading positions once, then bucket into segments.
            heading_lines: list[int] = []
            with p.open(encoding="utf-8", errors="ignore") as fh:
                for idx, line in enumerate(fh, start=1):
                    s = line.strip()
                    if (
                        s.startswith("## ")
                        or s.startswith("### ")
                        or s.startswith("#### ")
                    ):
                        heading_lines.append(idx)
            for r in segs:
                ls, le = r["line_start"], r["line_end"]
                hits = [h for h in heading_lines if ls <= h <= le]
                if len(hits) >= min_subheadings:
                    suggestions.append(
                        {
                            "segment_id": r["id"],
                            "source_file": sf,
                            "tag": r["tag"],
                            "topic_name": r["topic_name"],
                            "line_start": ls,
                            "line_end": le,
                            "line_count": le - ls + 1,
                            "subheadings_at": hits,
                        }
                    )
        except Exception:
            continue
    return {"suggestions": suggestions}


@app.get("/dashboard/overview")
def api_dashboard() -> dict:
    """D1: single-shot aggregated metrics so the UI can render 'how much the
    system has saved me' in one place. All numbers are current state snapshots."""
    with connect() as conn:
        counts = {}
        for t in (
            "chunks",
            "tag_segments",
            "search_history",
            "search_misses",
            "answer_cache",
            "meta_memory",
            "ocr_pending",
            "builds",
        ):
            try:
                counts[t] = conn.execute(f"SELECT COUNT(1) c FROM {t}").fetchone()["c"]
            except Exception:
                counts[t] = 0
        # conflict_pending: show only actually-open ones (matches list_conflicts default)
        try:
            counts["conflict_pending"] = conn.execute(
                "SELECT COUNT(1) c FROM conflict_pending WHERE status = 'pending'"
            ).fetchone()["c"]
        except Exception:
            counts["conflict_pending"] = 0
        # Build attribution distribution
        attr = conn.execute(
            "SELECT completed_by, COUNT(1) c FROM builds GROUP BY completed_by"
        ).fetchall()
        attribution = {r["completed_by"] or "(unknown)": r["c"] for r in attr}
        # Cache savings
        cache_row = conn.execute(
            "SELECT COALESCE(SUM(hit_count), 0) hits, COUNT(1) entries "
            "FROM answer_cache"
        ).fetchone()
        cache_stats = {
            "entries": cache_row["entries"],
            "total_hits": int(cache_row["hits"] or 0),
        }
        # Token usage totals across builds
        tok_row = conn.execute(
            "SELECT COALESCE(SUM(estimated_cost_cny), 0) cost FROM builds"
        ).fetchone()
        # Recent activity — note builds only (users care about their note,
        # not the wiki ingest cadence).
        last_ingest = conn.execute(
            "SELECT id, created_at, completed_by, source_file FROM builds "
            "WHERE source_file NOT LIKE 'wiki:%' "
            "ORDER BY created_at DESC LIMIT 1"
        ).fetchone()
        last_wiki_ingest = conn.execute(
            "SELECT id, created_at, completed_by, source_file FROM builds "
            "WHERE source_file LIKE 'wiki:%' "
            "ORDER BY created_at DESC LIMIT 1"
        ).fetchone()
        # Trust leaders — top chunks by trust score
        trust_top = conn.execute(
            "SELECT id, source_ref, trust_score FROM chunks "
            "WHERE trust_score > 0 ORDER BY trust_score DESC LIMIT 5"
        ).fetchall()
        # Top gaps
        gap_row = conn.execute(
            "SELECT query_text, COUNT(1) c FROM search_misses "
            "WHERE created_at >= datetime('now', '-7 days') "
            "GROUP BY query_text ORDER BY c DESC LIMIT 5"
        ).fetchall()
    return {
        "counts": counts,
        "build_attribution": attribution,
        "answer_cache": cache_stats,
        "total_cost_cny": float(tok_row["cost"] or 0),
        "last_ingest": dict(last_ingest) if last_ingest else None,
        "last_wiki_ingest": dict(last_wiki_ingest) if last_wiki_ingest else None,
        "trust_top_chunks": [dict(r) for r in trust_top],
        "recent_gaps": [dict(r) for r in gap_row],
    }


@app.post("/chat/stream")
def api_chat_stream(req: ChatRequest):
    """B2: streaming variant of /chat. Sends SSE frames as the provider
    emits tokens. On non-Anthropic providers that don't support streaming,
    falls back to a single 'data: <full answer>' frame."""

    def gen():
        # Reuse the non-streaming implementation for evidence assembly.
        try:
            search_result = None
            if req.evidence_ids:
                with connect() as conn:
                    ph = ",".join("?" for _ in req.evidence_ids)
                    rows = conn.execute(
                        f"SELECT id, text, source_ref, source_file, dimension "
                        f"FROM chunks WHERE id IN ({ph})",
                        req.evidence_ids,
                    ).fetchall()
                evidence = [dict(r) for r in rows]
            else:
                search_result = search(req.query, req.topk)
                evidence = search_result["results"]
            ev_lines = []
            for i, e in enumerate(evidence):
                t = (e.get("text") or "").strip()
                r = e.get("source_ref", "")
                if t:
                    ev_lines.append(f"[{i + 1}] ({r}) {t}")
            user_prompt = (
                f"问题: {req.query}\n\n"
                f"{len(ev_lines)} 条证据:\n"
                + "\n".join(ev_lines)
                + "\n\n引用时使用 [N]。"
            )
            system = (
                "You are a precise knowledge assistant. "
                "Always cite evidence using [N]. Never fabricate."
            )
            mm_prelude = _meta_memory_prelude(req.query)
            if mm_prelude:
                system = mm_prelude + "\n\n" + system

            evidence_ids_log = [
                e.get("id") for e in evidence if isinstance(e.get("id"), int)
            ]
            yield f"event: evidence\ndata: {json.dumps({'ids': evidence_ids_log}, ensure_ascii=False)}\n\n"

            # Emit source_files like /chat does, so clients can cache them
            # for deep follow-ups. Same dedup + top-3 cap as the non-stream path.
            _seen_sf: set[str] = set()
            _top_sf: list[str] = []
            for _e in evidence:
                _sf = _e.get("source_file", "")
                if _sf and _sf not in _seen_sf and Path(_sf).exists():
                    _seen_sf.add(_sf)
                    _top_sf.append(_sf)
                    if len(_top_sf) >= 3:
                        break
            if _top_sf:
                yield f"event: source_files\ndata: {json.dumps({'files': _top_sf}, ensure_ascii=False)}\n\n"

            # Minimal streaming call — OpenAI-compatible stream=true
            headers = {
                "Authorization": f"Bearer {settings.provider_api_key}",
                "Content-Type": "application/json",
            }
            url = f"{settings.provider_base_url.rstrip('/')}/chat/completions"
            payload = {
                "model": settings.provider_chat_model,
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": user_prompt},
                ],
                "temperature": 0.2,
                "stream": True,
            }
            stream_start = time.time()
            accumulated = []  # accumulate deltas for post-stream logging
            with requests.post(
                url, headers=headers, json=payload, stream=True, timeout=60
            ) as resp:
                resp.raise_for_status()
                for raw in resp.iter_lines():
                    if not raw:
                        continue
                    line = raw.decode("utf-8", errors="ignore")
                    if not line.startswith("data:"):
                        continue
                    payload_part = line[5:].strip()
                    if not payload_part or payload_part == "[DONE]":
                        continue
                    try:
                        chunk = json.loads(payload_part)
                        delta = (
                            chunk.get("choices", [{}])[0]
                            .get("delta", {})
                            .get("content", "")
                        )
                        if delta:
                            accumulated.append(delta)
                            yield f"data: {json.dumps({'delta': delta}, ensure_ascii=False)}\n\n"
                    except (json.JSONDecodeError, KeyError, IndexError):
                        continue

            # Persist so streamed answers can also receive 👍/👎 feedback and
            # feed the trust_score / adaptive-weight loops.
            full_answer = "".join(accumulated)
            latency_ms = int((time.time() - stream_start) * 1000)
            answer_id = 0
            try:
                with connect() as conn:
                    qid_row = conn.execute(
                        "SELECT id FROM query_logs ORDER BY id DESC LIMIT 1"
                    ).fetchone()
                    qid = qid_row["id"] if qid_row else 0
                    conn.execute(
                        "INSERT INTO answer_logs(query_id, answer_text, evidence_refs, "
                        "model_name, latency_ms) VALUES(?, ?, ?, ?, ?)",
                        (
                            qid,
                            full_answer,
                            json.dumps(evidence_ids_log),
                            settings.provider_chat_model,
                            latency_ms,
                        ),
                    )
                    answer_id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
                    conn.commit()
            except Exception:
                pass
            yield f"event: done\ndata: {json.dumps({'answer_id': answer_id, 'latency_ms': latency_ms}, ensure_ascii=False)}\n\n"
        except Exception as e:
            yield f"event: error\ndata: {json.dumps({'error': str(e)})}\n\n"

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ── Append to Raw Note File ──


class AppendNoteRequest(BaseModel):
    raw_path: str
    content: str


@app.post("/note/append")
def api_note_append(req: AppendNoteRequest) -> dict:
    """Append content to a raw note file. Creates the file if it doesn't exist."""
    p = Path(req.raw_path)
    p.parent.mkdir(parents=True, exist_ok=True)
    existing = p.read_text(encoding="utf-8") if p.exists() else ""
    sep = ""
    if existing and not existing.endswith("\n\n"):
        sep = "\n" if existing.endswith("\n") else "\n\n"
    p.write_text(f"{existing}{sep}{req.content.strip()}\n", encoding="utf-8")
    return {
        "ok": True,
        "path": str(p.resolve()),
        "bytes_written": len(req.content.strip()),
    }


# ── Special Knowledge Ingest ──


class SpecialIngestRequest(BaseModel):
    folder_path: str
    topic_name: str | None = None
    ai_delegate: bool = False


@app.post("/special-ingest")
def api_special_ingest(req: SpecialIngestRequest) -> dict:
    """Ingest a folder as a specialknowledge topic."""
    from app.special_ingest import ingest_folder

    try:
        result = ingest_folder(
            req.folder_path, topic_name=req.topic_name, ai_delegate=req.ai_delegate
        )
        if req.ai_delegate:
            result = {**result, "ai_delegated": True}
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/special-knowledge")
def api_special_knowledge() -> dict:
    """List all specialknowledge topics."""
    with connect() as conn:
        rows = conn.execute(
            "SELECT id, topic_name, summary, source_file, entities_json, created_at FROM tag_segments WHERE tag LIKE 'wiki:%' ORDER BY created_at DESC"
        ).fetchall()
    topics = []
    seen = set()
    for r in rows:
        if r["topic_name"] in seen:
            continue
        seen.add(r["topic_name"])
        # Extract category from entities_json metadata
        category = "reference"
        try:
            meta = json.loads(r["entities_json"]) if r["entities_json"] else {}
            if isinstance(meta, dict):
                category = meta.get("category", "reference")
        except (json.JSONDecodeError, TypeError):
            pass
        topics.append(
            {
                "id": r["id"],
                "topic": r["topic_name"],
                "summary": r["summary"],
                "folder": r["source_file"],
                "category": category,
                "created_at": r["created_at"],
            }
        )
    return {"topics": topics}


@app.delete("/special-knowledge/{topic_name}")
def api_special_knowledge_delete(topic_name: str) -> dict:
    """Delete a wiki topic, its chunks, and source .md files on disk."""
    dimension = f"wiki:{topic_name}"
    files_deleted = []
    with connect() as conn:
        # Collect source files before deleting chunks
        source_rows = conn.execute(
            "SELECT DISTINCT source_file FROM chunks WHERE dimension = ?", (dimension,)
        ).fetchall()
        build_rows = conn.execute(
            "SELECT DISTINCT build_id FROM chunks WHERE dimension = ?", (dimension,)
        ).fetchall()
        chunk_del = conn.execute(
            "DELETE FROM chunks WHERE dimension = ?", (dimension,)
        ).rowcount
        seg_del = conn.execute(
            "DELETE FROM tag_segments WHERE tag = ?", (dimension,)
        ).rowcount
        for br in build_rows:
            bid = br["build_id"]
            remaining = conn.execute(
                "SELECT COUNT(1) c FROM chunks WHERE build_id = ?", (bid,)
            ).fetchone()["c"]
            if remaining == 0:
                conn.execute("DELETE FROM builds WHERE id = ?", (bid,))
        conn.commit()

    # Delete source .md files from disk
    for row in source_rows:
        sf = row["source_file"]
        p = Path(sf)
        if p.exists() and p.suffix == ".md":
            try:
                p.unlink()
                files_deleted.append(sf)
            except OSError:
                pass

    return {
        "deleted": topic_name,
        "chunks_removed": chunk_del,
        "segments_removed": seg_del,
        "files_deleted": files_deleted,
    }


# ── Wiki optimization + grouping (P0) ──


@app.get("/wiki/find")
def api_wiki_find(
    q: str = Query(..., min_length=1), top_k: int = Query(5, ge=1, le=20)
) -> dict:
    """Resolve a natural-language query to existing wiki topic candidates.

    Ranks by (a) embedding cosine between query and topic centroid (when
    available), and (b) substring / keyword overlap on topic_name + summary.
    Used by MCP callers to pick an EXISTING topic to optimize rather than
    create a new one.
    """
    with connect() as conn:
        topics = conn.execute(
            "SELECT id, build_id, topic_name, tag, summary, keywords_json, "
            "source_file, centroid_json FROM tag_segments "
            "WHERE tag LIKE 'wiki:%' ORDER BY created_at DESC"
        ).fetchall()
    if not topics:
        return {"candidates": []}

    # Compute query embedding once
    try:
        qv = embed_texts([q])[0]
    except Exception:
        qv = None

    import math as _math

    ql = q.lower()
    ranked: list[tuple[float, dict]] = []
    for t in topics:
        name = (t["topic_name"] or "").strip()
        summary = (t["summary"] or "").strip()
        try:
            kws = json.loads(t["keywords_json"] or "[]")
        except (json.JSONDecodeError, TypeError):
            kws = []

        # Lexical score
        name_low = name.lower()
        sum_low = summary.lower()
        lex = 0.0
        if ql in name_low:
            lex += 0.6
        elif any(tok in name_low for tok in ql.split() if len(tok) >= 2):
            lex += 0.35
        if ql in sum_low:
            lex += 0.3
        for kw in kws[:30]:
            if not isinstance(kw, str):
                continue
            if ql in kw.lower() or kw.lower() in ql:
                lex += 0.1
                break

        # Semantic score via centroid
        sem = 0.0
        if qv and t["centroid_json"]:
            try:
                centroid = json.loads(t["centroid_json"])
                if centroid and len(centroid) == len(qv):
                    dot = sum(a * b for a, b in zip(qv, centroid))
                    na = _math.sqrt(sum(a * a for a in qv))
                    nb = _math.sqrt(sum(b * b for b in centroid))
                    if na > 1e-9 and nb > 1e-9:
                        sem = max(0.0, dot / (na * nb))
            except (json.JSONDecodeError, TypeError):
                pass

        score = 0.55 * sem + 0.45 * min(lex, 1.0)
        if score < 0.1 and not lex and not sem:
            continue
        # Derive group from source_file path convention:
        # .../sn/source/<group>/<topic>/<file.md> vs .../sn/source/<topic>/<file.md>
        group = ""
        sf = t["source_file"] or ""
        try:
            from app.config import settings as _cfg

            src_root = Path(_cfg.wiki_sources_dir).resolve()
            rel = Path(sf).resolve().relative_to(src_root)
            parts = rel.parts
            if len(parts) >= 2:
                group = parts[0]
        except Exception:
            pass
        ranked.append(
            (
                score,
                {
                    "topic_name": name,
                    "tag": t["tag"],
                    "summary": summary[:400],
                    "keywords": kws[:12],
                    "source_file": sf,
                    "group": group if group and group != name else "",
                    "build_id": t["build_id"],
                    "score": round(score, 3),
                    "lex": round(lex, 3),
                    "sem": round(sem, 3),
                },
            )
        )
    ranked.sort(key=lambda x: x[0], reverse=True)
    return {"candidates": [r[1] for r in ranked[:top_k]]}


@app.get("/wiki/source")
def api_wiki_source(topic: str = Query(..., min_length=1)) -> dict:
    """Return the raw markdown of a wiki topic so an MCP caller can review
    before proposing a rewrite."""
    with connect() as conn:
        row = conn.execute(
            "SELECT source_file, topic_name FROM tag_segments "
            "WHERE tag = ? OR tag = ? OR topic_name = ? LIMIT 1",
            (f"wiki:{topic}", topic, topic),
        ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail=f"wiki topic not found: {topic}")
    sf = row["source_file"]
    # source_file is the containing folder for wiki topics; find the .md inside.
    p = Path(sf)
    candidates: list[Path] = []
    if p.is_dir():
        candidates = sorted(p.rglob("*.md"))
    elif p.suffix.lower() == ".md" and p.exists():
        candidates = [p]
    if not candidates:
        raise HTTPException(status_code=404, detail=f"no .md file under {sf}")
    # Prefer a file whose name matches the topic
    picked = candidates[0]
    for c in candidates:
        if topic in c.stem:
            picked = c
            break
    try:
        content = picked.read_text(encoding="utf-8", errors="ignore")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    return {
        "topic_name": row["topic_name"] or topic,
        "md_path": str(picked.resolve()),
        "content": content,
        "length": len(content),
    }


class WikiUpdateRequest(BaseModel):
    topic_name: str
    content: str
    delegate_enrich: bool = True


@app.post("/wiki/update")
def api_wiki_update(req: WikiUpdateRequest) -> dict:
    """Overwrite a wiki topic's .md AND rebuild its index (chunks + embeddings
    + segments). Used by MCP callers to optimize an existing wiki in place
    rather than creating a duplicate.
    """
    from app.special_ingest import ingest_folder
    from app.versioning import create_snapshot

    topic = req.topic_name.strip()
    if not topic or not req.content.strip():
        raise HTTPException(
            status_code=400, detail="topic_name + non-empty content required"
        )

    # Locate existing topic folder
    with connect() as conn:
        row = conn.execute(
            "SELECT source_file, build_id FROM tag_segments "
            "WHERE tag = ? OR tag = ? OR topic_name = ? LIMIT 1",
            (f"wiki:{topic}", topic, topic),
        ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail=f"wiki topic not found: {topic}")
    topic_dir = Path(row["source_file"])
    if not topic_dir.is_dir():
        topic_dir = topic_dir.parent
    if not topic_dir.exists():
        raise HTTPException(status_code=404, detail=f"topic dir missing: {topic_dir}")

    # Snapshot the existing build (best effort) before wipe.
    try:
        create_snapshot(str(topic_dir), reason="pre-wiki-update")
    except Exception:
        pass

    # Wipe old chunks + segments for this topic so re-ingest doesn't duplicate.
    dim = f"wiki:{topic}"
    with connect() as conn:
        old_build_ids = [
            r["build_id"]
            for r in conn.execute(
                "SELECT DISTINCT build_id FROM chunks WHERE dimension = ?", (dim,)
            ).fetchall()
        ]
        conn.execute("DELETE FROM chunks WHERE dimension = ?", (dim,))
        conn.execute("DELETE FROM tag_segments WHERE tag = ?", (dim,))
        for bid in old_build_ids:
            conn.execute(
                "DELETE FROM builds WHERE id = ? AND source_file LIKE 'wiki:%'", (bid,)
            )
        conn.commit()

    # Overwrite the primary .md inside the topic dir.
    import re as _re

    safe = _re.sub(r"[^\w\s\u4e00-\u9fff-]", "_", topic)[:80]
    md_path = topic_dir / f"{safe}.md"
    # If a differently-named file was the source, prefer overwriting that one.
    existing_mds = sorted(topic_dir.glob("*.md"))
    if existing_mds and not md_path.exists():
        md_path = existing_mds[0]
    md_path.write_text(req.content.strip() + "\n", encoding="utf-8")

    # Re-ingest the folder under the same topic_name.
    result = ingest_folder(
        str(topic_dir), topic_name=topic, ai_delegate=req.delegate_enrich
    )
    return {
        **result,
        "updated": True,
        "md_path": str(md_path.resolve()),
    }


@app.post("/wiki/redistill")
def api_wiki_redistill(topic: str = Query(..., min_length=1)) -> dict:
    """Reset enrichment state for a wiki topic without touching the .md.
    Clears chunk ai_summary + topic summary + marks build awaiting_enrich
    so Claude re-distills from scratch (better chunk summaries, topic
    summary, and keyword sets). Embeddings + chunk text are kept."""
    from app.builds import recompute_enrich_status

    dim = f"wiki:{topic}"
    with connect() as conn:
        touched = conn.execute(
            "UPDATE chunks SET ai_summary = '' WHERE dimension = ?", (dim,)
        ).rowcount
        conn.execute(
            "UPDATE tag_segments SET summary = '', keywords_json = '[]' WHERE tag = ?",
            (dim,),
        )
        build_ids = [
            r["build_id"]
            for r in conn.execute(
                "SELECT DISTINCT build_id FROM chunks WHERE dimension = ?", (dim,)
            ).fetchall()
        ]
        conn.commit()
    if touched == 0:
        raise HTTPException(
            status_code=404, detail=f"no chunks found for wiki topic: {topic}"
        )
    for bid in build_ids:
        try:
            recompute_enrich_status(bid)
        except Exception:
            pass
    return {
        "topic": topic,
        "chunks_cleared": touched,
        "builds_flipped": build_ids,
    }


@app.get("/wiki/groups")
def api_wiki_groups() -> dict:
    """List wiki topics bucketed by group (derived from source path:
    `sn/source/<group>/<topic>/`). Topics stored directly at `sn/source/<topic>/`
    report group = '' (ungrouped)."""
    src_root = Path(settings.wiki_sources_dir).resolve()
    with connect() as conn:
        rows = conn.execute(
            "SELECT topic_name, tag, summary, source_file FROM tag_segments "
            "WHERE tag LIKE 'wiki:%' ORDER BY topic_name"
        ).fetchall()
    groups: dict[str, list[dict]] = {}
    for r in rows:
        sf = r["source_file"] or ""
        group = ""
        try:
            rel = Path(sf).resolve().relative_to(src_root)
            parts = rel.parts
            if len(parts) >= 2 and parts[0] != rel.stem:
                group = parts[0]
        except Exception:
            pass
        groups.setdefault(group, []).append(
            {
                "topic_name": r["topic_name"],
                "tag": r["tag"],
                "summary": (r["summary"] or "")[:240],
                "source_file": sf,
            }
        )
    return {
        "groups": [
            {"name": g, "topic_count": len(v), "topics": v}
            for g, v in sorted(groups.items(), key=lambda kv: (kv[0] == "", kv[0]))
        ]
    }


@app.post("/wiki/suggest-groups")
def api_wiki_suggest_groups() -> dict:
    """Cluster wiki topics by centroid cosine similarity and propose a
    grouping. Returns a plan that the MCP caller can review/edit before
    applying via /wiki/reorganize."""
    with connect() as conn:
        topics = conn.execute(
            "SELECT topic_name, tag, summary, keywords_json, centroid_json "
            "FROM tag_segments WHERE tag LIKE 'wiki:%' "
            "AND centroid_json != '' AND centroid_json IS NOT NULL"
        ).fetchall()
    if not topics:
        return {"groups": [], "note": "no topics with centroids — run ingest first"}

    try:
        import numpy as np
    except ImportError:
        raise HTTPException(status_code=500, detail="numpy required")

    names: list[str] = []
    vecs: list[list[float]] = []
    summaries: list[str] = []
    for t in topics:
        try:
            v = json.loads(t["centroid_json"])
        except (json.JSONDecodeError, TypeError):
            continue
        if not v:
            continue
        names.append(t["topic_name"])
        vecs.append(v)
        summaries.append((t["summary"] or "")[:200])
    if not vecs:
        return {"groups": [], "note": "no usable centroids"}

    arr = np.asarray(vecs, dtype=np.float32)
    norms = np.linalg.norm(arr, axis=1)
    norms[norms < 1e-9] = 1.0
    normed = arr / norms[:, None]
    sim = normed @ normed.T  # cosine matrix

    # Simple greedy agglomerative clustering: take highest unclustered
    # similarity pair, form a seed group, attach topics with avg-link sim >= threshold.
    threshold = 0.72
    n = len(names)
    assigned = [-1] * n
    cluster_id = 0
    for i in range(n):
        if assigned[i] >= 0:
            continue
        assigned[i] = cluster_id
        members = [i]
        for j in range(i + 1, n):
            if assigned[j] >= 0:
                continue
            avg = float(sim[j, members].mean())
            if avg >= threshold:
                assigned[j] = cluster_id
                members.append(j)
        cluster_id += 1

    # Build group proposals — name each group by shared keyword prefix of its
    # topics' names (simple heuristic; human can rename in the plan).
    groups: list[dict] = []
    for cid in range(cluster_id):
        member_idxs = [i for i, a in enumerate(assigned) if a == cid]
        if not member_idxs:
            continue
        member_names = [names[i] for i in member_idxs]
        # Name heuristic: common substring ≥ 2 chars across topic names, but
        # capped so single-member clusters don't end up with a 60-char name.
        shared = _common_substring(member_names)
        if len(member_names) == 1 or not shared:
            # Use first 12 chars of the first topic name as a stub the user
            # can rename in the plan before applying.
            name_suggestion = member_names[0][:12]
        else:
            name_suggestion = shared[:24]
        groups.append(
            {
                "name": name_suggestion,
                "topic_names": member_names,
                "avg_cohesion": round(
                    float(sim[np.ix_(member_idxs, member_idxs)].mean()),
                    3,
                ),
            }
        )
    groups.sort(key=lambda g: -len(g["topic_names"]))
    return {
        "groups": groups,
        "threshold": threshold,
        "total_topics": n,
        "note": "Review and edit topic_names per group before calling /wiki/reorganize.",
    }


def _common_substring(strings: list[str], min_len: int = 2) -> str:
    """Longest common substring across given strings; empty if none meets min_len."""
    if not strings:
        return ""
    shortest = min(strings, key=len)
    for length in range(len(shortest), min_len - 1, -1):
        for start in range(0, len(shortest) - length + 1):
            candidate = shortest[start : start + length]
            if all(candidate in s for s in strings):
                return candidate
    return ""


class WikiReorganizeRequest(BaseModel):
    # [{ "name": "回传", "topic_names": ["回传自查SOP", ...] }, ...]
    groups: list[dict]
    # Dry-run returns the planned moves without touching the filesystem.
    dry_run: bool = False


@app.post("/wiki/reorganize")
def api_wiki_reorganize(req: WikiReorganizeRequest) -> dict:
    """Apply a grouping plan: physically move each topic's folder under its
    group's parent dir AND update DB `source_file` paths so retrieval/search
    keep working. Missing groups/topics are skipped with a warning — never
    destructive to files that aren't mentioned."""
    import re as _re
    import shutil as _sh

    src_root = Path(settings.wiki_sources_dir).resolve()
    if not src_root.exists():
        raise HTTPException(status_code=500, detail=f"wiki root missing: {src_root}")

    with connect() as conn:
        topic_rows = conn.execute(
            "SELECT topic_name, tag, source_file FROM tag_segments WHERE tag LIKE 'wiki:%'"
        ).fetchall()
    topic_to_src: dict[str, str] = {
        r["topic_name"]: r["source_file"] for r in topic_rows if r["topic_name"]
    }

    moves: list[dict] = []
    warnings: list[str] = []

    for group in req.groups or []:
        raw_name = (group.get("name") or "").strip()
        if not raw_name:
            warnings.append("skipping group with empty name")
            continue
        group_slug = _re.sub(r"[^\w\s\u4e00-\u9fff-]", "_", raw_name)[:80]
        group_dir = src_root / group_slug

        for topic_name in group.get("topic_names", []) or []:
            sf = topic_to_src.get(topic_name)
            if not sf:
                warnings.append(f"topic not found in DB: {topic_name}")
                continue
            src_path = Path(sf)
            if src_path.is_file():
                src_path = src_path.parent
            src_path = src_path.resolve()
            if not src_path.exists():
                warnings.append(f"source dir missing: {src_path}")
                continue
            # Avoid the `<group>/<group>/` nested-twin case — if the topic
            # folder's name equals the group slug, strip one layer.
            inner_name = src_path.name
            if inner_name == group_slug:
                # Move contents of src_path into group_dir instead.
                moves.append(
                    {
                        "topic_name": topic_name,
                        "from": str(src_path),
                        "to": str(group_dir),
                        "group": raw_name,
                        "merge_contents": True,
                    }
                )
                continue
            dest_path = group_dir / inner_name
            if src_path == dest_path.resolve():
                continue  # already in place
            moves.append(
                {
                    "topic_name": topic_name,
                    "from": str(src_path),
                    "to": str(dest_path),
                    "group": raw_name,
                }
            )

    if req.dry_run:
        return {"dry_run": True, "moves": moves, "warnings": warnings}

    applied: list[dict] = []
    errors: list[dict] = []
    with connect() as conn:
        for mv in moves:
            src = Path(mv["from"])
            dest = Path(mv["to"])
            try:
                if mv.get("merge_contents"):
                    # <group>/<group>/ collision: move each child of src
                    # directly into the group dir, then remove empty src.
                    dest.mkdir(parents=True, exist_ok=True)
                    for child in src.iterdir():
                        target = dest / child.name
                        if target.exists():
                            errors.append({**mv, "error": f"child exists: {target}"})
                            continue
                        _sh.move(str(child), str(target))
                    try:
                        src.rmdir()
                    except OSError:
                        pass
                    # Rewrite DB paths: src → dest (no trailing slash issues;
                    # REPLACE handles sub-paths).
                    src_prefix = str(src)
                    dest_prefix = str(dest)
                    conn.execute(
                        "UPDATE chunks SET source_file = REPLACE(source_file, ?, ?) "
                        "WHERE source_file LIKE ?",
                        (src_prefix, dest_prefix, src_prefix + "%"),
                    )
                    conn.execute(
                        "UPDATE tag_segments SET source_file = REPLACE(source_file, ?, ?) "
                        "WHERE source_file LIKE ?",
                        (src_prefix, dest_prefix, src_prefix + "%"),
                    )
                    applied.append(mv)
                    continue
                dest.parent.mkdir(parents=True, exist_ok=True)
                if dest.exists():
                    errors.append({**mv, "error": "destination already exists"})
                    continue
                _sh.move(str(src), str(dest))
                src_prefix = str(src)
                dest_prefix = str(dest)
                conn.execute(
                    "UPDATE chunks SET source_file = REPLACE(source_file, ?, ?) "
                    "WHERE source_file LIKE ?",
                    (src_prefix, dest_prefix, src_prefix + "%"),
                )
                conn.execute(
                    "UPDATE tag_segments SET source_file = REPLACE(source_file, ?, ?) "
                    "WHERE source_file LIKE ?",
                    (src_prefix, dest_prefix, src_prefix + "%"),
                )
                applied.append(mv)
            except Exception as e:
                errors.append({**mv, "error": str(e)})
        conn.commit()

    # Piggyback cleanup hints: after the reorg, surface unambiguous orphan
    # files so the caller can follow up with a targeted dedupe call.
    # Only delete-worthy entries (identical / near_dup / subset) are included;
    # review/import classes stay silent to keep this short and actionable.
    cleanup: list[dict] = []
    try:
        from app.wiki_dedup import cleanup_hints as _cleanup_hints

        cleanup = _cleanup_hints(max_items=20)
    except Exception:
        pass

    return {
        "dry_run": False,
        "applied": applied,
        "errors": errors,
        "warnings": warnings,
        "cleanup_hints": cleanup,
    }


@app.post("/wiki/unnest-doubles")
def api_wiki_unnest_doubles(dry_run: bool = Query(False)) -> dict:
    """Fix `<group>/<same-name>/*` double-nested leftovers from older
    reorganize runs. Walks wiki_sources_dir, finds any dir whose sole child
    dir has the same name, lifts that child's contents one level up, and
    updates DB paths.

    Idempotent: runs on nothing when the tree is already clean.
    """
    import shutil as _sh

    src_root = Path(settings.wiki_sources_dir).resolve()
    if not src_root.exists():
        raise HTTPException(status_code=500, detail=f"wiki root missing: {src_root}")

    plan: list[dict] = []
    # Look at each top-level group dir
    for group in src_root.iterdir():
        if not group.is_dir() or group.name.startswith("."):
            continue
        # Does the group contain exactly one child dir with the same name?
        children = [c for c in group.iterdir() if not c.name.startswith(".")]
        inner_same = [c for c in children if c.is_dir() and c.name == group.name]
        if not inner_same:
            continue
        # Only merge if the inner is the ONLY substantive child, otherwise
        # we might conflate intentional co-location.
        if len(children) > 1:
            non_empty = [c for c in children if c.name != group.name]
            if non_empty:
                continue
        inner = inner_same[0]
        lifts: list[dict] = []
        for item in inner.iterdir():
            target = group / item.name
            if target.exists():
                lifts.append(
                    {"item": str(item), "target": str(target), "error": "target exists"}
                )
                continue
            lifts.append({"item": str(item), "target": str(target)})
        plan.append({"inner": str(inner), "group": str(group), "lifts": lifts})

    if dry_run:
        return {"dry_run": True, "plan": plan}

    applied: list[dict] = []
    errors: list[dict] = []
    with connect() as conn:
        for p in plan:
            inner = Path(p["inner"])
            group = Path(p["group"])
            ok = True
            for lift in p["lifts"]:
                if lift.get("error"):
                    errors.append(lift)
                    ok = False
                    continue
                try:
                    _sh.move(lift["item"], lift["target"])
                except Exception as e:
                    errors.append({**lift, "error": str(e)})
                    ok = False
            if ok:
                # Remove inner (now empty) and update any DB paths that still
                # reference the nested location.
                try:
                    for leftover in inner.iterdir():
                        if leftover.name.startswith("."):
                            leftover.unlink(missing_ok=True)
                    inner.rmdir()
                except OSError as e:
                    errors.append({"inner": str(inner), "error": f"rmdir: {e}"})
                    continue
                conn.execute(
                    "UPDATE chunks SET source_file = REPLACE(source_file, ?, ?) "
                    "WHERE source_file LIKE ?",
                    (str(inner), str(group), str(inner) + "%"),
                )
                conn.execute(
                    "UPDATE tag_segments SET source_file = REPLACE(source_file, ?, ?) "
                    "WHERE source_file LIKE ?",
                    (str(inner), str(group), str(inner) + "%"),
                )
                applied.append(
                    {"lifted": p["inner"], "into": p["group"], "items": len(p["lifts"])}
                )
        conn.commit()
    return {"dry_run": False, "applied": applied, "errors": errors}


@app.get("/wiki/duplicates")
def api_wiki_duplicates() -> dict:
    """Scan wiki_sources_dir for orphan .md/.txt files + classify against
    imported topics. Suggested actions: delete (identical/near-dup/subset),
    review (similar), import (distinct), skip (unreadable)."""
    from app.wiki_dedup import find_duplicate_wiki_sources

    return {"candidates": find_duplicate_wiki_sources()}


class DedupActionsRequest(BaseModel):
    actions: list[dict]  # [{path, action, ...}]
    dry_run: bool = True


@app.post("/wiki/dedupe")
def api_wiki_dedupe(req: DedupActionsRequest) -> dict:
    from app.wiki_dedup import apply_dedup_actions

    return apply_dedup_actions(req.actions, dry_run=req.dry_run)


class WikiFlattenRequest(BaseModel):
    # When empty, process every wiki topic. Otherwise only the named ones.
    topic_names: list[str] = []
    dry_run: bool = False


@app.post("/wiki/flatten")
def api_wiki_flatten(req: WikiFlattenRequest) -> dict:
    """Collapse single-.md topic dirs into a group-level file.

    For each eligible topic whose folder contains exactly ONE .md file and
    no other meaningful assets: move the .md to the parent (group) dir and
    remove the empty folder. Updates DB paths so retrieval keeps working.

    Topics with multiple .md files, PDFs, images, or nested subdirs are
    skipped — their subdir is the logical boundary for related assets.
    """
    import shutil as _sh

    with connect() as conn:
        where = ""
        params: list = []
        if req.topic_names:
            ph = ",".join("?" for _ in req.topic_names)
            where = f" AND topic_name IN ({ph})"
            params = list(req.topic_names)
        rows = conn.execute(
            f"SELECT topic_name, source_file FROM tag_segments "
            f"WHERE tag LIKE 'wiki:%'{where}",
            params,
        ).fetchall()

    plan: list[dict] = []
    skipped: list[dict] = []
    for r in rows:
        topic = r["topic_name"]
        sf = Path(r["source_file"]) if r["source_file"] else None
        if not sf or not sf.exists():
            skipped.append({"topic": topic, "reason": "path missing"})
            continue
        topic_dir = sf if sf.is_dir() else sf.parent
        if not topic_dir.exists() or not topic_dir.is_dir():
            skipped.append({"topic": topic, "reason": "not a folder"})
            continue

        # Eligibility: exactly one .md, nothing else interesting.
        children = [p for p in topic_dir.iterdir() if not p.name.startswith(".")]
        md_files = [p for p in children if p.suffix.lower() == ".md"]
        non_md = [p for p in children if p.suffix.lower() != ".md"]
        if len(md_files) != 1:
            skipped.append(
                {
                    "topic": topic,
                    "reason": f"has {len(md_files)} .md files (need exactly 1)",
                }
            )
            continue
        if non_md:
            skipped.append(
                {
                    "topic": topic,
                    "reason": f"has non-md assets: {[p.name for p in non_md]}",
                }
            )
            continue

        md = md_files[0]
        # Target: group_dir/<topic_name>.md — preserve topic name in filename
        # so it's self-describing at the flat level.
        import re as _re

        safe = _re.sub(r"[^\w\s\u4e00-\u9fff-]", "_", topic)[:80]
        dest = topic_dir.parent / f"{safe}.md"
        if dest.exists() and dest.resolve() != md.resolve():
            skipped.append(
                {
                    "topic": topic,
                    "reason": f"destination already exists: {dest}",
                }
            )
            continue
        plan.append(
            {
                "topic": topic,
                "from_md": str(md),
                "from_dir": str(topic_dir),
                "to_md": str(dest),
            }
        )

    if req.dry_run:
        return {"dry_run": True, "plan": plan, "skipped": skipped}

    applied: list[dict] = []
    errors: list[dict] = []
    with connect() as conn:
        for p in plan:
            try:
                src_md = Path(p["from_md"])
                src_dir = Path(p["from_dir"])
                dest_md = Path(p["to_md"])
                if src_md.resolve() != dest_md.resolve():
                    _sh.move(str(src_md), str(dest_md))
                # Remove emptied dir
                try:
                    src_dir.rmdir()
                except OSError:
                    # Dir still had hidden files (.DS_Store etc); clean
                    # them out and retry once.
                    for f in src_dir.iterdir():
                        if f.name.startswith("."):
                            f.unlink(missing_ok=True)
                    try:
                        src_dir.rmdir()
                    except OSError:
                        pass
                # Update DB: anything pointing into src_dir → dest_md
                conn.execute(
                    "UPDATE chunks SET source_file = REPLACE(source_file, ?, ?) "
                    "WHERE source_file LIKE ?",
                    (str(src_md), str(dest_md), str(src_md) + "%"),
                )
                # tag_segments pointed at the DIR, not the .md. Retarget to
                # the flat .md so read_wiki_source + preview still work.
                conn.execute(
                    "UPDATE tag_segments SET source_file = ? "
                    "WHERE source_file = ? AND tag LIKE 'wiki:%'",
                    (str(dest_md), str(src_dir)),
                )
                applied.append(p)
            except Exception as e:
                errors.append({**p, "error": str(e)})
        conn.commit()
    return {
        "dry_run": False,
        "applied": applied,
        "skipped": skipped,
        "errors": errors,
    }


@app.get("/wiki-sources")
def api_wiki_sources() -> dict:
    """List all distinct source .md files from wiki chunks for the Sources panel.

    Each source also carries a `rel_path` computed server-side relative to
    `wiki_sources_dir` — so the client-side tree never has to know or worry
    about the absolute filesystem location. If a source somehow lives outside
    the wiki dir, its rel_path falls back to just the filename.
    """
    import os as _os

    base_dir = Path(_os.path.expanduser(settings.wiki_sources_dir)).resolve()
    base_dir_str = str(base_dir)

    with connect() as conn:
        rows = conn.execute(
            """
            SELECT DISTINCT c.source_file, c.dimension,
                   ts.topic_name, ts.entities_json
            FROM chunks c
            LEFT JOIN tag_segments ts ON ts.tag = c.dimension
            WHERE c.dimension LIKE 'wiki:%'
              AND c.source_file LIKE '%.md'
            ORDER BY c.source_file
            """
        ).fetchall()
    sources = []
    seen = set()
    for r in rows:
        sf = r["source_file"]
        if sf in seen:
            continue
        seen.add(sf)
        category = "reference"
        try:
            meta = json.loads(r["entities_json"]) if r["entities_json"] else {}
            if isinstance(meta, dict):
                category = meta.get("category", "reference")
        except (json.JSONDecodeError, TypeError):
            pass
        # Resolve to absolute path so Electron can read the file
        abs_path = str(Path(sf).resolve()) if not sf.startswith("/") else sf
        # Compute path relative to wiki root; fall back to basename if the
        # file somehow lives outside (defensive — shouldn't happen).
        try:
            rel_path = _os.path.relpath(abs_path, base_dir_str)
            if rel_path.startswith(".."):
                rel_path = Path(abs_path).name
        except ValueError:
            rel_path = Path(abs_path).name
        sources.append(
            {
                "path": abs_path,
                "rel_path": rel_path,
                "name": Path(sf).stem,
                "topic": r["topic_name"] or "",
                "category": category,
            }
        )
    return {
        "sources": sources,
        "base_dir": base_dir_str,
    }


# ── Runtime settings (persisted in DB, hot-reloadable) ──


@app.get("/settings")
def api_get_settings() -> dict:
    from app.config import current_settings_dict

    return current_settings_dict()


class SettingsUpdateRequest(BaseModel):
    # All fields optional — only provided keys are updated.
    embedding_mode: str | None = None
    provider_base_url: str | None = None
    provider_api_key: str | None = None
    provider_chat_model: str | None = None
    embed_base_url: str | None = None
    embed_api_key: str | None = None
    provider_embed_model: str | None = None
    ai_features_enabled: bool | None = None
    ingest_ai_enabled: bool | None = None
    ingest_ai_model: str | None = None
    prompt_cache_mode: str | None = None
    wiki_sources_dir: str | None = None
    ocr_langs: str | None = None
    cloud_sync_enabled: bool | None = None
    cloud_sync_url: str | None = None
    cloud_sync_api_key: str | None = None


@app.post("/settings")
def api_update_settings(req: SettingsUpdateRequest) -> dict:
    """Persist settings to DB and apply them live to the running backend."""
    from app.config import save_settings_to_db, current_settings_dict

    updates = {k: v for k, v in req.model_dump().items() if v is not None}
    save_settings_to_db(updates)
    return {
        "ok": True,
        "applied": list(updates.keys()),
        "settings": current_settings_dict(),
    }


# ── SmartNote Cloud sync ────────────────────────────────────────


@app.get("/sync/status")
def api_sync_status() -> dict:
    """Snapshot for the Settings UI — enabled, cloud URL, per-kind counts,
    last push/pull timestamps, open conflicts."""
    from app import cloud_sync
    return cloud_sync.sync_status()


class SyncTestRequest(BaseModel):
    url: str | None = None
    api_key: str | None = None


@app.post("/sync/test")
def api_sync_test(req: SyncTestRequest | None = None) -> dict:
    """Probe cloud reachability + api key validity.

    Accepts optional body `{"url": "...", "api_key": "..."}` so the
    Settings UI can test unsaved form values. Body omitted → falls
    back to the persisted settings.
    """
    from app import cloud_sync
    if req is None:
        return cloud_sync.test_connection()
    return cloud_sync.test_connection(
        override_url=req.url,
        override_api_key=req.api_key,
    )


@app.get("/sync/preview")
def api_sync_preview() -> dict:
    """Dry-run: what would /sync/push upload? No cloud calls."""
    from app import cloud_sync
    try:
        return cloud_sync.preview()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


class SyncPushOneRequest(BaseModel):
    kind: str
    local_id: str


@app.post("/sync/push-one")
def api_sync_push_one(req: SyncPushOneRequest) -> dict:
    """Push a single (kind, local_id) pair. Used by the UI's per-item
    progress loop so the user can cancel mid-batch."""
    from app import cloud_sync
    try:
        return cloud_sync.push_one(req.kind, req.local_id)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/sync/push")
def api_sync_push() -> dict:
    """Push every local entity that has drifted from its recorded
    sync_state. Returns a per-kind summary of actions taken."""
    from app import cloud_sync
    try:
        return cloud_sync.push_all()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/sync/pull")
def api_sync_pull() -> dict:
    """Pull every remote document we care about (filtered by
    smartnote_type) and apply it locally. LWW conflict policy with
    losing snapshots saved to sync_conflicts."""
    from app import cloud_sync
    try:
        return cloud_sync.pull_all()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/sync/full")
def api_sync_full() -> dict:
    """Serial push-then-pull. One call, both directions."""
    from app import cloud_sync
    try:
        return cloud_sync.full_sync()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/sync/conflicts")
def api_sync_conflicts(limit: int = 50) -> dict:
    """Recent conflict snapshots for recovery UI."""
    from app.db import connect as _connect
    with _connect() as conn:
        rows = conn.execute(
            "SELECT id, local_kind, local_id, cloud_doc_id, direction, "
            "SUBSTR(lost_content, 1, 500) AS preview, LENGTH(lost_content) AS full_length, "
            "created_at FROM sync_conflicts ORDER BY id DESC LIMIT ?",
            (limit,),
        ).fetchall()
    return {"conflicts": [dict(r) for r in rows]}


@app.get("/ocr-langs")
def api_ocr_langs() -> dict:
    """List installed OCR language packs and active config."""
    from app.pdf_convert import get_installed_ocr_langs
    import shutil

    has_tesseract = shutil.which("tesseract") is not None
    langs = get_installed_ocr_langs()
    active = settings.ocr_langs or ""
    return {"installed": langs, "has_tesseract": has_tesseract, "active": active}


class OcrConfigRequest(BaseModel):
    ocr_langs: str  # e.g. "chi_sim+eng"


@app.post("/ocr-langs/config")
def api_ocr_config(req: OcrConfigRequest) -> dict:
    """Save active OCR language config to .env."""
    import dotenv

    env_path = Path(".env")
    if env_path.exists():
        dotenv.set_key(str(env_path), "OCR_LANGS", req.ocr_langs)
    else:
        env_path.write_text(f"OCR_LANGS={req.ocr_langs}\n")
    # Update runtime
    settings.ocr_langs = req.ocr_langs
    return {"ok": True, "ocr_langs": req.ocr_langs}


# ── MCP Server Management ──


@app.get("/mcp/servers")
def api_mcp_servers() -> dict:
    from app.mcp_client import list_servers

    return {"servers": list_servers()}


class McpServerRequest(BaseModel):
    name: str
    url: str
    transport: str = "streamable_http"
    auth: dict = {}


@app.post("/mcp/servers")
def api_mcp_server_add(req: McpServerRequest) -> dict:
    from app.mcp_client import add_server

    servers = add_server(req.name, req.url, req.transport, req.auth)
    return {"servers": servers}


@app.delete("/mcp/servers/{name}")
def api_mcp_server_delete(name: str) -> dict:
    from app.mcp_client import remove_server

    servers = remove_server(name)
    return {"servers": servers}


@app.get("/mcp/servers/{name}/tools")
def api_mcp_tools(name: str) -> dict:
    from app.mcp_client import mcp_list_tools

    try:
        tools = mcp_list_tools(name)
        return {"tools": tools}
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


class McpCallRequest(BaseModel):
    tool_name: str
    arguments: dict = {}


@app.post("/mcp/servers/{name}/call")
def api_mcp_call(name: str, req: McpCallRequest) -> dict:
    from app.mcp_client import mcp_call_tool

    try:
        result = mcp_call_tool(name, req.tool_name, req.arguments)
        return {"content": result}
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


@app.get("/mcp/servers/{name}/resources")
def api_mcp_resources(name: str) -> dict:
    from app.mcp_client import mcp_list_resources

    try:
        resources = mcp_list_resources(name)
        return {"resources": resources}
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


class McpReadResourceRequest(BaseModel):
    uri: str


@app.post("/mcp/servers/{name}/resources/read")
def api_mcp_read_resource(name: str, req: McpReadResourceRequest) -> dict:
    from app.mcp_client import mcp_read_resource

    try:
        content = mcp_read_resource(name, req.uri)
        return {"content": content}
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


# ── Wiki Import: URL ──


class UrlImportRequest(BaseModel):
    url: str
    topic_name: str = ""
    ai_delegate: bool = False


@app.post("/wiki/import-url")
def api_wiki_import_url(req: UrlImportRequest) -> dict:
    """Fetch a URL, convert to markdown, and ingest as wiki topic."""
    from app.url_import import import_url
    from app.special_ingest import ingest_folder

    wiki_dir = Path(settings.wiki_sources_dir)
    wiki_dir.mkdir(parents=True, exist_ok=True)
    try:
        result = import_url(req.url, str(wiki_dir), req.topic_name or None)
        md_path = Path(result["md_path"]).resolve()
        # Ingest only the directory containing this specific file
        ingest_result = ingest_folder(
            str(md_path.parent),
            topic_name=result["topic_name"],
            ai_delegate=req.ai_delegate,
        )
        if req.ai_delegate:
            ingest_result = {**ingest_result, "ai_delegated": True}
        return {**ingest_result, "md_path": str(md_path), "source_url": req.url}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ── Wiki Import: MCP Document ──


class McpDocImportRequest(BaseModel):
    server_name: str
    doc_url: str = ""  # Feishu doc URL — auto-extract doc ID
    document_id: str = ""  # Or pass doc ID directly
    topic_name: str = ""
    ai_delegate: bool = False


def _extract_feishu_doc_id(url: str) -> str:
    """Extract document ID from Feishu/Lark wiki/doc URL.
    e.g. https://xxx.feishu.cn/wiki/Jt78wVLEJiqPN3kPIorcoOtjngf → Jt78wVLEJiqPN3kPIorcoOtjngf
    """
    import re

    # Match wiki or docx URLs
    m = re.search(r"(?:wiki|docx|docs)/([A-Za-z0-9]+)", url)
    if m:
        return m.group(1)
    # Fallback: last path segment
    parts = [p for p in url.rstrip("/").split("/") if p]
    return parts[-1] if parts else ""


def _extract_title_from_content(content: str) -> str:
    """Extract document title from content — first non-empty line."""
    for line in content.split("\n"):
        stripped = line.strip().lstrip("# ").strip()
        if stripped and len(stripped) < 200:
            return stripped
    return ""


@app.post("/wiki/import-mcp")
def api_wiki_import_mcp(req: McpDocImportRequest) -> dict:
    """Fetch document from MCP server and ingest as wiki topic.

    When ai_delegate=True the raw content is parked in `pending_format_docs`
    and no ingest runs. Claude is expected to submit the rewritten markdown
    via POST /enrich-bulk with kind='doc_format', which triggers a delegated
    wiki ingest downstream.
    """
    from app.mcp_client import mcp_call_tool

    try:
        # Resolve document ID
        doc_id = req.document_id
        if not doc_id and req.doc_url:
            doc_id = _extract_feishu_doc_id(req.doc_url)
        if not doc_id:
            raise ValueError("Provide a document URL or document_id")

        # Call docx_v1_document_rawContent
        content = mcp_call_tool(
            req.server_name,
            "docx_v1_document_rawContent",
            {"path": {"document_id": doc_id}},
        )

        if not content or not content.strip():
            raise ValueError("MCP returned empty document content")

        # Extract title from content (already unwrapped at mcp_client layer)
        title = _extract_title_from_content(content)
        topic = req.topic_name or title or doc_id

        # Save as .md — per-topic subdirectory to avoid cross-contamination
        wiki_dir = Path(settings.wiki_sources_dir)
        wiki_dir.mkdir(parents=True, exist_ok=True)
        import re as _re

        safe_name = _re.sub(r"[^\w\s\u4e00-\u9fff-]", "_", topic)[:80]
        topic_dir = wiki_dir / safe_name
        topic_dir.mkdir(parents=True, exist_ok=True)

        # Delegate path: park raw content awaiting Claude rewrite
        if req.ai_delegate:
            from app.mcp_import import _new_format_id

            format_id = _new_format_id()
            with connect() as conn:
                conn.execute(
                    """
                    INSERT INTO pending_format_docs(format_id, topic_name, title, raw_content, source, target_dir, status)
                    VALUES (?, ?, ?, ?, ?, ?, 'awaiting')
                    """,
                    (
                        format_id,
                        topic,
                        title,
                        content,
                        f"mcp:{req.server_name}:{doc_id}",
                        str(topic_dir),
                    ),
                )
                conn.commit()
            return {
                "status": "awaiting_format",
                "format_id": format_id,
                "topic": topic,
                "title": title,
                "raw_length": len(content),
                "target_dir": str(topic_dir),
                "source": f"mcp:{req.server_name}",
            }

        md_path = topic_dir / f"{safe_name}.md"
        md_path.write_text(content, encoding="utf-8")

        # Ingest only this topic's directory
        from app.special_ingest import ingest_folder

        result = ingest_folder(str(topic_dir), topic_name=topic)
        return {
            **result,
            "md_path": str(md_path.resolve()),
            "title": title,
            "source": f"mcp:{req.server_name}",
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


class TagAddRequest(BaseModel):
    name: str
    desc: str = ""


class TagReorderRequest(BaseModel):
    order: list[str]


@app.get("/tags")
def api_tags() -> dict:
    """Get all available tags with segment counts (from active build)."""
    tags_config = get_tags_with_desc()
    active = get_active_build_id()
    with connect() as conn:
        counts = {}
        if active:
            for row in conn.execute(
                "SELECT tag, COUNT(1) c, SUM(line_end - line_start + 1) lines FROM tag_segments WHERE build_id = ? GROUP BY tag",
                (active,),
            ).fetchall():
                counts[row["tag"]] = {"segments": row["c"], "lines": row["lines"]}
        else:
            for row in conn.execute(
                "SELECT tag, COUNT(1) c, SUM(line_end - line_start + 1) lines FROM tag_segments GROUP BY tag"
            ).fetchall():
                counts[row["tag"]] = {"segments": row["c"], "lines": row["lines"]}
    return {
        "active_build": active,
        "tags": [
            {
                "name": t["name"],
                "desc": t.get("desc", ""),
                "color": t.get("color", "gray"),
                "segments": counts.get(t["name"], {}).get("segments", 0),
                "lines": counts.get(t["name"], {}).get("lines", 0),
            }
            for t in tags_config
        ],
    }


@app.post("/tags/add")
def api_tag_add(req: TagAddRequest) -> dict:
    tags = add_tag(req.name.strip(), req.desc.strip())
    return {"tags": tags}


@app.delete("/tags/{tag_name}")
def api_tag_delete(tag_name: str) -> dict:
    tags = delete_tag(tag_name)
    return {"tags": tags}


@app.post("/tags/reorder")
def api_tag_reorder(req: TagReorderRequest) -> dict:
    tags = reorder_tags(req.order)
    return {"tags": tags}


class TagColorRequest(BaseModel):
    name: str
    color: str


@app.post("/tags/color")
def api_tag_color(req: TagColorRequest) -> dict:
    tags = set_tag_color(req.name, req.color)
    return {"tags": tags}


@app.get("/tags/colors")
def api_tag_colors() -> dict:
    return {"colors": TAG_COLORS}


# ── Search history ──


@app.get("/search/gaps")
def api_search_gaps(limit: int = Query(20, ge=1, le=200)) -> dict:
    """Return recurring search misses grouped by normalized query. A knowledge
    base that gets used the most will develop characteristic gaps — this
    endpoint surfaces them so Claude (or the user) can proactively ingest
    content to fill them.
    """
    with connect() as conn:
        rows = conn.execute(
            """
            SELECT query_text, COUNT(1) c, MAX(created_at) last_seen,
                   AVG(top_score) avg_top, AVG(result_count) avg_results
            FROM search_misses
            WHERE created_at >= datetime('now', '-60 days')
            GROUP BY query_text
            ORDER BY c DESC, last_seen DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
    return {
        "gaps": [
            {
                "query": r["query_text"],
                "miss_count": r["c"],
                "last_seen": r["last_seen"],
                "avg_top_score": round(float(r["avg_top"] or 0), 3),
                "avg_result_count": round(float(r["avg_results"] or 0), 2),
            }
            for r in rows
        ]
    }


class MetaMemoryRequest(BaseModel):
    kind: str = "rule"
    text: str
    scope: str = "global"


@app.get("/meta-memory")
def api_meta_memory_list(limit: int = Query(100, ge=1, le=500)) -> dict:
    with connect() as conn:
        rows = conn.execute(
            "SELECT id, kind, text, scope, hit_count, created_at, updated_at "
            "FROM meta_memory ORDER BY hit_count DESC, updated_at DESC LIMIT ?",
            (limit,),
        ).fetchall()
    return {
        "memories": [
            {
                "id": r["id"],
                "kind": r["kind"],
                "text": r["text"],
                "scope": r["scope"],
                "hit_count": r["hit_count"],
                "created_at": r["created_at"],
                "updated_at": r["updated_at"],
            }
            for r in rows
        ]
    }


@app.post("/meta-memory")
def api_meta_memory_add(req: MetaMemoryRequest) -> dict:
    text = (req.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="text is required")
    with connect() as conn:
        # De-dup exact text within same scope
        existing = conn.execute(
            "SELECT id FROM meta_memory WHERE text = ? AND scope = ?",
            (text, req.scope),
        ).fetchone()
        if existing:
            conn.execute(
                "UPDATE meta_memory SET hit_count = hit_count + 1, "
                "updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                (existing["id"],),
            )
            conn.commit()
            return {"id": existing["id"], "deduped": True}
        conn.execute(
            "INSERT INTO meta_memory(kind, text, scope) VALUES(?, ?, ?)",
            ((req.kind or "rule").strip(), text, (req.scope or "global").strip()),
        )
        new_id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
        conn.commit()
    return {"id": new_id, "deduped": False}


@app.delete("/meta-memory/{memory_id}")
def api_meta_memory_delete(memory_id: int) -> dict:
    with connect() as conn:
        conn.execute("DELETE FROM meta_memory WHERE id = ?", (memory_id,))
        conn.commit()
    return {"deleted": memory_id}


@app.get("/search/history")
def api_search_history() -> dict:
    with connect() as conn:
        rows = conn.execute(
            "SELECT id, query_text, result_count, tag_filter, created_at FROM search_history ORDER BY created_at DESC LIMIT 20"
        ).fetchall()
    return {
        "history": [
            {
                "id": r["id"],
                "query": r["query_text"],
                "result_count": r["result_count"],
                "tag_filter": r["tag_filter"],
                "created_at": r["created_at"],
            }
            for r in rows
        ]
    }


@app.get("/tags/stats")
def api_tag_stats() -> dict:
    """Tag statistics: counts, line coverage, growth over time."""
    with connect() as conn:
        tag_counts = conn.execute(
            "SELECT tag, COUNT(1) segments, SUM(line_end - line_start + 1) lines FROM tag_segments GROUP BY tag ORDER BY segments DESC"
        ).fetchall()
        total_lines = sum(r["lines"] for r in tag_counts) or 1
        # Growth: segments created per day (last 30 days)
        growth = conn.execute(
            """
            SELECT DATE(created_at) as day, tag, COUNT(1) c
            FROM tag_segments
            WHERE created_at >= DATE('now', '-30 days')
            GROUP BY day, tag
            ORDER BY day
            """
        ).fetchall()
    return {
        "tags": [
            {
                "name": r["tag"],
                "segments": r["segments"],
                "lines": r["lines"],
                "coverage_pct": round(r["lines"] / total_lines * 100, 1),
            }
            for r in tag_counts
        ],
        "daily_growth": [
            {"day": r["day"], "tag": r["tag"], "count": r["c"]} for r in growth
        ],
    }


@app.get("/tags/all-segments")
def api_all_tag_segments() -> dict:
    """Get all tag segments across all tags, sorted by line position.
    Used by the note editor to show inline tag annotations."""
    active = get_active_build_id()
    with connect() as conn:
        if active:
            rows = conn.execute(
                "SELECT id, source_file, tag, topic_name, line_start, line_end, summary, keywords_json, is_credential FROM tag_segments WHERE tag NOT LIKE 'wiki:%' AND build_id = ? ORDER BY line_start, line_end",
                (active,),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT id, source_file, tag, topic_name, line_start, line_end, summary, keywords_json, is_credential FROM tag_segments WHERE tag NOT LIKE 'wiki:%' ORDER BY line_start, line_end"
            ).fetchall()
    segments = [
        {
            "id": r["id"],
            "source_file": r["source_file"],
            "tag": r["tag"],
            "topic_name": r["topic_name"] if "topic_name" in r.keys() else "",
            "line_start": r["line_start"],
            "line_end": r["line_end"],
            "summary": r["summary"],
            "keywords": json.loads(r["keywords_json"]) if r["keywords_json"] else [],
            "is_credential": bool(r["is_credential"]),
        }
        for r in rows
    ]
    return {"segments": segments}


@app.get("/tags/{tag_name}")
def api_tag_segments(tag_name: str) -> dict:
    """Get all segments for a specific tag (from active build)."""
    active = get_active_build_id()
    with connect() as conn:
        if active:
            rows = conn.execute(
                "SELECT id, source_file, tag, topic_name, line_start, line_end, summary, keywords_json, is_credential FROM tag_segments WHERE tag = ? AND build_id = ? ORDER BY source_file, line_start",
                (tag_name, active),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT id, source_file, tag, topic_name, line_start, line_end, summary, keywords_json, is_credential FROM tag_segments WHERE tag = ? ORDER BY source_file, line_start",
                (tag_name,),
            ).fetchall()
    segments = [
        {
            "id": r["id"],
            "source_file": r["source_file"],
            "topic_name": r["topic_name"] if "topic_name" in r.keys() else "",
            "line_start": r["line_start"],
            "line_end": r["line_end"],
            "summary": r["summary"],
            "keywords": json.loads(r["keywords_json"]) if r["keywords_json"] else [],
            "is_credential": bool(r["is_credential"]),
        }
        for r in rows
    ]
    return {"tag": tag_name, "segments": segments}


@app.get("/tags/{tag_name}/source")
def api_tag_source_lines(tag_name: str, segment_id: int = Query(...)) -> dict:
    """Get the original source lines for a tag segment."""
    with connect() as conn:
        row = conn.execute(
            "SELECT source_file, line_start, line_end FROM tag_segments WHERE id = ?",
            (segment_id,),
        ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Segment not found")

    try:
        lines = _read_lines_inclusive(
            row["source_file"], row["line_start"], row["line_end"]
        )
        return {
            "file": row["source_file"],
            "line_start": row["line_start"],
            "line_end": row["line_end"],
            "lines": lines,
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ── Skills (reusable recipes read by Claude/Cursor/OpenCode) ──────
# Notes record meaningful skills. SmartNote stores the recipe and packages the
# time-sliced note context so any CLI can execute and report back.


class SkillSaveRequest(BaseModel):
    name: str
    description: str = ""
    nodes: list[dict]
    kind: str = "periodic"
    period_hint: str = "weekly"
    source_segment_ids: list[int] | None = None


@app.get("/skills")
def api_skills_list() -> dict:
    return {"templates": skill.list_templates()}


@app.get("/skills/{name}")
def api_skill_get(name: str) -> dict:
    try:
        return skill.get_template(name)
    except KeyError:
        raise HTTPException(status_code=404, detail="skill not found")


@app.post("/skills")
def api_skill_save(req: SkillSaveRequest) -> dict:
    try:
        return skill.save_template(
            name=req.name,
            description=req.description,
            nodes=req.nodes,
            kind=req.kind,
            period_hint=req.period_hint,
            source_segment_ids=req.source_segment_ids,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.delete("/skills/{template_id}")
def api_skill_delete(template_id: int) -> dict:
    deleted = skill.delete_template(template_id)
    return {"deleted": deleted}


class SkillNodePatch(BaseModel):
    index: int
    name: str | None = None
    description: str | None = None
    trigger_hints: list[str] | None = None
    expected_tag: str | None = None


class SkillPatchRequest(BaseModel):
    # Text-only field updates. Structural changes (add/remove/reorder nodes)
    # go through POST /skills with the full nodes array.
    description: str | None = None
    new_name: str | None = None
    kind: str | None = None
    period_hint: str | None = None
    nodes: list[SkillNodePatch] | None = None


@app.patch("/skills/{name}")
def api_skill_patch(name: str, req: SkillPatchRequest) -> dict:
    try:
        node_patches = None
        if req.nodes is not None:
            node_patches = [
                {
                    k: v
                    for k, v in p.model_dump().items()
                    if v is not None or k == "index"
                }
                for p in req.nodes
            ]
        return skill.patch_template(
            name,
            description=req.description,
            new_name=req.new_name,
            kind=req.kind,
            period_hint=req.period_hint,
            node_patches=node_patches,
        )
    except KeyError:
        raise HTTPException(status_code=404, detail="skill not found")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


class SkillRunRequest(BaseModel):
    slice_days: int = 7
    triggered_by: str = "ui"


@app.post("/skills/{name}/run")
def api_skill_run(name: str, req: SkillRunRequest) -> dict:
    """Create a pending run. Returns the bundle (template + sliced notes)
    that the CLI will read to execute. Does NOT execute anything server-side."""
    try:
        return skill.trigger_run(
            name, slice_days=req.slice_days, triggered_by=req.triggered_by
        )
    except KeyError:
        raise HTTPException(status_code=404, detail="skill not found")


class SkillRunResultRequest(BaseModel):
    status: str  # 'completed' | 'skipped'
    result_summary: str = ""
    steps: list[dict] | None = None


@app.post("/skill-runs/{run_id}/result")
def api_skill_run_result(run_id: int, req: SkillRunResultRequest) -> dict:
    try:
        return skill.record_run_result(
            run_id=run_id,
            status=req.status,
            result_summary=req.result_summary,
            steps=req.steps,
        )
    except KeyError:
        raise HTTPException(status_code=404, detail="run not found")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.get("/skill-runs")
def api_skill_runs_list(
    template_id: int | None = None,
    status: str | None = None,
    limit: int = 30,
) -> dict:
    return {
        "runs": skill.list_runs(template_id=template_id, status=status, limit=limit)
    }


@app.get("/skill-runs/{run_id}")
def api_skill_run_get(run_id: int) -> dict:
    try:
        return skill.get_run(run_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="run not found")


@app.get("/skill-runs/{run_id}/bundle")
def api_skill_run_bundle(run_id: int) -> dict:
    """Re-materialize the (template + sliced notes) bundle for a pending run —
    used when a CLI resumes a run it didn't create."""
    try:
        return skill.get_run_bundle(run_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="run not found")


# ── Pack-aware note save/load + per-line metadata ────────────────
# Each save creates a pending ingest pack; each load detects external
# edits and creates an external pack if the file changed outside SmartNote.
# Every save also stamps per-line ts/hash so the note gutter can render it.


class NoteSaveRequest(BaseModel):
    raw_path: str
    content: str
    note: str = ""


@app.post("/note/save")
def api_note_save(req: NoteSaveRequest) -> dict:
    """Write file + create pending ingest pack + stamp per-line metadata.
    Also re-runs each view's populate pass against the updated file so
    newly appended lines that match a view's rules are auto-classified.
    Populate runs additively (replace=False), so manual adds and manual
    exclusions are preserved."""
    try:
        result = packs.on_save(req.raw_path, req.content, note=req.note)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    # Auto-classify: let each view pick up any new matching lines. Failures
    # here are non-fatal — the save itself already succeeded.
    auto_classify: list[dict] = []
    try:
        for v in note_views.list_views(req.raw_path):
            rule = v.get("rule") or {}
            if not (rule.get("keywords") or rule.get("regex") or rule.get("ai_query")):
                continue
            try:
                r = note_views.populate(v["id"], replace=False)
                auto_classify.append({
                    "view_id": v["id"],
                    "name": v["name"],
                    "total_hits": r.get("total_hits", 0),
                })
            except Exception:
                continue
    except Exception:
        pass
    result["auto_classify"] = auto_classify
    return result


@app.get("/note/load")
def api_note_load(raw_path: str = Query(...)) -> dict:
    """Read file content. If on-disk md5 differs from the stored baseline,
    create an 'external' ingest pack so the user sees the change in the
    pending queue."""
    try:
        return packs.on_load(raw_path)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/note/line-meta")
def api_note_line_meta(raw_path: str = Query(...)) -> dict:
    return {"lines": packs.list_line_meta(raw_path)}


class LineMarkRequest(BaseModel):
    raw_path: str
    line_hash: str
    bookmark: str | None = None
    highlight_color: str | None = None
    highlight_note: str | None = None
    # Best-effort hints so an upsert can populate a useful row when the line
    # isn't tracked yet (file never saved through /note/save). ts stays NULL.
    line_preview: str | None = None
    line_no: int | None = None


@app.post("/note/line-mark")
def api_note_line_mark(req: LineMarkRequest) -> dict:
    return packs.set_line_mark(
        file_path=req.raw_path,
        line_hash=req.line_hash,
        bookmark=req.bookmark,
        highlight_color=req.highlight_color,
        highlight_note=req.highlight_note,
        line_preview=req.line_preview,
        line_no=req.line_no,
    )


# ── Note views (topical lenses over a single raw file) ──────────


class NoteViewCreate(BaseModel):
    raw_path: str
    name: str
    rule: dict | None = None
    display: dict | None = None


class NoteViewUpdate(BaseModel):
    name: str | None = None
    rule: dict | None = None
    display: dict | None = None
    sort_order: int | None = None


class NoteViewMemberOp(BaseModel):
    line_hash: str
    line_preview: str | None = None


class NoteViewMembersRequest(BaseModel):
    add: list[NoteViewMemberOp] | None = None
    remove: list[str] | None = None
    exclude: list[NoteViewMemberOp] | None = None


class NoteViewPopulateRequest(BaseModel):
    rule: dict | None = None
    replace: bool = False


@app.get("/note/views")
def api_note_views_list(raw_path: str = Query(...)) -> dict:
    return {"views": note_views.list_views(raw_path)}


@app.post("/note/views")
def api_note_views_create(req: NoteViewCreate) -> dict:
    v = note_views.create_view(
        raw_path=req.raw_path,
        name=req.name,
        rule=req.rule,
        display=req.display,
    )
    return {"view": v}


@app.patch("/note/views/{view_id}")
def api_note_views_update(view_id: int, req: NoteViewUpdate) -> dict:
    v = note_views.update_view(
        view_id,
        name=req.name,
        rule=req.rule,
        display=req.display,
        sort_order=req.sort_order,
    )
    if not v:
        raise HTTPException(status_code=404, detail="view not found")
    return {"view": v}


@app.delete("/note/views/{view_id}")
def api_note_views_delete(view_id: int) -> dict:
    note_views.delete_view(view_id)
    return {"ok": True}


@app.post("/note/views/{view_id}/populate")
def api_note_views_populate(view_id: int, req: NoteViewPopulateRequest) -> dict:
    return note_views.populate(view_id, rule=req.rule, replace=req.replace)


@app.post("/note/views/{view_id}/members")
def api_note_views_members(view_id: int, req: NoteViewMembersRequest) -> dict:
    add = [m.model_dump() for m in (req.add or [])]
    exclude = [m.model_dump() for m in (req.exclude or [])]
    return note_views.set_members(
        view_id, add=add, remove=req.remove, exclude=exclude,
    )


@app.get("/note/views/{view_id}/resolve")
def api_note_views_resolve(view_id: int, raw_path: str | None = None) -> dict:
    return note_views.resolve(view_id, raw_path=raw_path)


# ── Pack queue ───────────────────────────────────────────────────


@app.get("/packs")
def api_packs_list(
    raw_path: str | None = None,
    status: str = "pending",
    limit: int = 50,
) -> dict:
    items = packs.list_packs(raw_path=raw_path, status=status, limit=limit)
    return {
        "packs": items,
        "pending_count": packs.pending_count(raw_path=raw_path),
    }


@app.post("/packs/{pack_id}/apply")
def api_pack_apply(pack_id: int) -> dict:
    """Trigger ingest for the pack's raw file + mark this pack applied.
    Returns {pack, build_id, applied_siblings_count}."""
    try:
        pack = packs.get_pack(pack_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="pack not found")
    if pack["status"] != "pending":
        return {"pack": pack, "build_id": None, "applied_siblings_count": 0}

    # Trigger the ingest against the pack's file. Use prefs.notePath as the
    # derived note.md target (existing convention).
    from app.ingest import ingest_raw

    prefs = api_prefs()
    note_path = prefs.get("notePath") or str(
        Path(pack["raw_path"]).with_name("note.md")
    )
    try:
        # Pack apply runs an incremental, non-AI ingest: it should not pay the
        # latency/cost of full LLM classification — that's what the explicit
        # "Rebuild all" full ingest is for. The top-right pill in the note UI
        # surfaces how many packs have been applied since the last full ingest.
        result = ingest_raw(
            pack["raw_path"],
            note_path,
            reset=False,
            ai_delegate=False,
            force_no_ai=True,
        )
        build_id = result.get("build_id")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"ingest failed: {e}")

    # Mark this pack + all other pending siblings for the same file as applied
    # under the same build.
    applied_count = packs.apply_all_for_path(pack["raw_path"], build_id=build_id)
    packs.update_file_state(
        pack["raw_path"],
        Path(pack["raw_path"]).read_text(encoding="utf-8"),
        last_build_id=build_id,
    )
    return {
        "pack": packs.get_pack(pack_id),
        "build_id": build_id,
        "applied_siblings_count": applied_count,
    }


class PacksApplyAllRequest(BaseModel):
    raw_path: str


@app.post("/packs/apply-all")
def api_packs_apply_all(req: PacksApplyAllRequest) -> dict:
    """Apply every pending pack for a raw file with a single ingest run."""
    pending = packs.list_packs(raw_path=req.raw_path, status="pending", limit=500)
    if not pending:
        return {"applied": 0, "build_id": None}

    from app.ingest import ingest_raw

    prefs = api_prefs()
    note_path = prefs.get("notePath") or str(Path(req.raw_path).with_name("note.md"))
    try:
        result = ingest_raw(
            req.raw_path,
            note_path,
            reset=False,
            ai_delegate=False,
            force_no_ai=True,
        )
        build_id = result.get("build_id")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"ingest failed: {e}")

    count = packs.apply_all_for_path(req.raw_path, build_id=build_id)
    packs.update_file_state(
        req.raw_path,
        Path(req.raw_path).read_text(encoding="utf-8"),
        last_build_id=build_id,
    )
    return {"applied": count, "build_id": build_id}


@app.get("/packs/stats")
def api_packs_stats(raw_path: str) -> dict:
    """Counts for the top-right pill: how many non-AI pack-apply builds have
    stacked up since the last full ingest for this file. When this number is
    large the user should consider running a full "Rebuild all" so AI
    classification catches up."""
    with connect() as conn:
        last_full = conn.execute(
            "SELECT id, created_at FROM builds "
            "WHERE source_file = ? AND ingest_kind = 'full' "
            "ORDER BY created_at DESC LIMIT 1",
            (raw_path,),
        ).fetchone()
        if last_full:
            applied_row = conn.execute(
                "SELECT COUNT(*) AS c FROM ingest_packs "
                "WHERE raw_path = ? AND status = 'applied' "
                "AND applied_at >= ?",
                (raw_path, last_full["created_at"]),
            ).fetchone()
        else:
            applied_row = conn.execute(
                "SELECT COUNT(*) AS c FROM ingest_packs "
                "WHERE raw_path = ? AND status = 'applied'",
                (raw_path,),
            ).fetchone()
        pending_row = conn.execute(
            "SELECT COUNT(*) AS c FROM ingest_packs "
            "WHERE raw_path = ? AND status = 'pending'",
            (raw_path,),
        ).fetchone()
    return {
        "applied_since_full": int(applied_row["c"] if applied_row else 0),
        "pending": int(pending_row["c"] if pending_row else 0),
        "last_full_build_id": last_full["id"] if last_full else None,
        "last_full_at": last_full["created_at"] if last_full else None,
    }


@app.post("/packs/{pack_id}/discard")
def api_pack_discard(pack_id: int) -> dict:
    try:
        return packs.discard_pack(pack_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="pack not found")


class PacksMergeRequest(BaseModel):
    pack_ids: list[int]


@app.post("/packs/merge")
def api_packs_merge(req: PacksMergeRequest) -> dict:
    try:
        return packs.merge_packs(req.pack_ids)
    except (ValueError, KeyError) as e:
        raise HTTPException(status_code=400, detail=str(e))


# ── Reorganize note by tag ──────────────────────────────────────
# Produces a candidate reorganized markdown (grouped by tag). User reviews
# the diff and approves; approval writes the file, snapshots it, and does
# a full reset-ingest. This is destructive — always show the diff first.


class ReorganizeRequest(BaseModel):
    raw_path: str


@app.post("/note/reorganize-preview")
def api_note_reorganize_preview(req: ReorganizeRequest) -> dict:
    from app import reorganize as _reorganize

    try:
        return _reorganize.build_candidate(req.raw_path)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


class ReorganizeApproveRequest(BaseModel):
    raw_path: str
    candidate: str  # the content the user approved (sent back verbatim)
    note_path: str | None = None


@app.post("/note/reorganize-approve")
def api_note_reorganize_approve(req: ReorganizeApproveRequest) -> dict:
    """Commit a reorganized note: snapshot → write → reset ingest.

    After this runs, ALL existing chunks for raw_path are wiped and
    re-generated from the new content. Pending ingest packs for this
    file are marked applied (they're meaningless against fresh chunks)."""
    p = Path(req.raw_path)
    if not p.exists():
        raise HTTPException(status_code=404, detail="raw_path does not exist")

    # note_path defaults to same directory + note.md (convention)
    note_path = req.note_path or str(p.with_name("note.md"))

    # 1. Snapshot so this is reversible.
    try:
        snap = create_snapshot(
            note_path, reason="reorganize-by-tag", extra_meta={"raw_path": req.raw_path}
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"snapshot failed: {e}")

    # 2. Write the candidate to raw_path. This is the point of no return
    #    without a snapshot restore.
    try:
        p.write_text(req.candidate, encoding="utf-8")
        packs.update_file_state(req.raw_path, req.candidate)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"write failed: {e}")

    # 3. Full reset ingest — old chunks wiped, new chunks generated.
    try:
        from app.ingest import ingest_raw

        result = ingest_raw(req.raw_path, note_path, reset=True, ai_delegate=False)
        build_id = result.get("build_id")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"ingest failed: {e}")

    # 4. Close out all pending packs for this file — they referenced the
    #    pre-reorganization content and no longer mean anything.
    applied = packs.apply_all_for_path(req.raw_path, build_id=build_id)

    return {
        "raw_path": req.raw_path,
        "build_id": build_id,
        "snapshot": snap,
        "packs_closed": applied,
        "bytes_written": len(req.candidate.encode("utf-8")),
    }
