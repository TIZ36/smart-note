from __future__ import annotations

import json
import time

import requests
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from app.adaptive import strengthen_profile
from app.config import settings
from app.db import connect, migrate_db
from app.embed import embed_texts
from app.knowledge_graph import get_graph
from app.memory import add_feedback, save_qa_memory
from app.rerank import rerank, rerank_with_llm
from app.builds import get_active_build_id, list_builds, activate_build, delete_build
from app.tags import get_all_tags, get_tags_with_desc, add_tag, delete_tag, reorder_tags, set_tag_color, TAG_COLORS
from app.retrieval import search
from app.rewrite import (
    generate_candidate,
    get_candidate_status,
    approve_candidate,
    reject_candidate,
    record_validation,
)
from app.versioning import list_versions, restore_version, create_snapshot, delete_version


app = FastAPI(title="IntelliNote Gateway")

# Auto-migrate DB on startup
try:
    migrate_db()
except Exception:
    pass

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Request models ──

class SearchRequest(BaseModel):
    query: str
    topk: int = 20
    tag_filter: str | None = None  # Filter results to a specific tag


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
    topk: int = 10


class FeedbackRequest(BaseModel):
    answer_id: int
    query_text: str = ""  # For strengthening query profiles
    feedback_type: str = "plus_one"


# ── Stage 1: Recall ──

@app.get("/health")
def health() -> dict:
    return {"status": "ok", "embedding_mode": settings.embedding_mode}


@app.post("/search")
def api_search(req: SearchRequest) -> dict:
    """Stage 1: Wide recall with 5 retrieval paths + adaptive weights."""
    result = search(req.query, req.topk, tag_filter=req.tag_filter)

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
        result_count = len(result.get("results", []))
        with connect() as conn:
            conn.execute(
                "INSERT INTO search_history(query_text, result_count, tag_filter) VALUES(?, ?, ?)",
                (req.query, result_count, req.tag_filter),
            )
            conn.execute("DELETE FROM search_history WHERE id NOT IN (SELECT id FROM search_history ORDER BY created_at DESC LIMIT 20)")
            conn.commit()
    except Exception:
        pass

    return result


# ── Stage 2: Rerank ──

@app.post("/rerank")
def api_rerank(req: RerankRequest) -> dict:
    """Stage 2: Rerank recall results using embedding similarity or LLM."""
    start = time.time()

    with connect() as conn:
        placeholders = ",".join("?" for _ in req.result_ids)
        rows = conn.execute(
            f"""
            SELECT id, text, source_ref, dimension, embedding_json, keywords_json, ai_summary
            FROM chunks
            WHERE id IN ({placeholders})
            """,
            req.result_ids,
        ).fetchall()

    results = [
        {
            "id": r["id"],
            "text": r["text"],
            "source_ref": r["source_ref"],
            "dimension": r["dimension"],
            "embedding_json": r["embedding_json"],
        }
        for r in rows
    ]

    if req.use_llm:
        reranked = rerank_with_llm(req.query, results, req.topk)
    else:
        reranked = rerank(req.query, results, req.topk)

    # Clean embedding from response
    for item in reranked:
        item.pop("embedding_json", None)
        item.pop("_embedding", None)

    latency = int((time.time() - start) * 1000)
    return {
        "results": reranked,
        "latency_ms": latency,
    }


# ── Stage 3: AI Answer ──

def _chat_completion(system: str, messages: list[dict]) -> str:
    if not settings.provider_api_key:
        return "Provider API key not configured."

    headers = {
        "Authorization": f"Bearer {settings.provider_api_key}",
        "Content-Type": "application/json",
    }
    url = f"{settings.provider_base_url.rstrip('/')}/chat/completions"
    all_messages = [{"role": "system", "content": system}] + messages
    payload = {
        "model": settings.provider_chat_model,
        "messages": all_messages,
        "temperature": 0.2,
    }
    resp = requests.post(url, headers=headers, json=payload, timeout=60)
    resp.raise_for_status()
    data = resp.json()
    return data["choices"][0]["message"]["content"]


@app.post("/chat")
def api_chat(req: ChatRequest) -> dict:
    """Stage 3: Generate AI answer from evidence context."""
    start = time.time()

    # If pre-filtered evidence IDs provided, use those
    if req.evidence_ids:
        with connect() as conn:
            placeholders = ",".join("?" for _ in req.evidence_ids)
            rows = conn.execute(
                f"SELECT id, text, source_ref, dimension FROM chunks WHERE id IN ({placeholders})",
                req.evidence_ids,
            ).fetchall()
        evidence = [
            {
                "id": r["id"],
                "text": r["text"],
                "source_ref": r["source_ref"],
                "dimension": r["dimension"],
            }
            for r in rows
        ]
    else:
        # Fallback: run search
        sr = search(req.query, req.topk)
        evidence = sr["results"]

    # Send top 75% of evidence to LLM (generous context, not just topk)
    cutoff = max(1, int(len(evidence) * 0.75))
    evidence_to_send = evidence[:cutoff]

    evidence_lines = []
    for i, e in enumerate(evidence_to_send):
        text = e.get("text", "").strip()
        ref = e.get("source_ref", "")
        if text:
            evidence_lines.append(f"[{i+1}] ({ref}) {text}")

    evidence_text = "\n".join(evidence_lines)

    user_prompt = (
        f"问题: {req.query}\n\n"
        f"以下是从用户的个人知识库中检索到的 {len(evidence_lines)} 条相关笔记。\n"
        f"请综合这些笔记内容回答问题。引用时使用 [1] [2] 等编号。\n\n"
        f"笔记内容:\n{evidence_text}\n\n"
        f"请先总结关键信息，再给出建议。"
    )

    # Build messages with conversation history for follow-ups
    messages: list[dict] = []
    for h in req.history[-6:]:  # Keep last 3 Q&A pairs max
        messages.append({"role": h.role, "content": h.content})
    messages.append({"role": "user", "content": user_prompt})

    try:
        answer = _chat_completion(
            "You are a precise knowledge assistant. Always cite evidence using [N] notation. "
            "Answer in the same language as the question. Avoid unsupported claims. "
            "If this is a follow-up question, reference the previous conversation context.",
            messages,
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc))

    latency = int((time.time() - start) * 1000)
    with connect() as conn:
        qid_row = conn.execute(
            "SELECT id FROM query_logs ORDER BY id DESC LIMIT 1"
        ).fetchone()
        qid = qid_row["id"] if qid_row else 0
        conn.execute(
            "INSERT INTO answer_logs(query_id, answer_text, evidence_refs, model_name, latency_ms) VALUES(?, ?, ?, ?, ?)",
            (
                qid,
                answer,
                json.dumps([e.get("source_ref") for e in evidence_to_send]),
                settings.provider_chat_model,
                latency,
            ),
        )
        answer_id = conn.execute(
            "SELECT id FROM answer_logs ORDER BY id DESC LIMIT 1"
        ).fetchone()["id"]
        conn.commit()

    return {
        "answer_id": answer_id,
        "answer": answer,
        "evidence": evidence,
        "latency_ms": latency,
    }


# ── Stage 4: Strengthen ──

@app.post("/feedback")
def api_feedback(req: FeedbackRequest) -> dict:
    """Stage 4: Strengthen — saves Q&A memory with params, updates query profiles."""
    add_feedback(req.answer_id, req.feedback_type)

    if req.feedback_type == "plus_one":
        # Strengthen the query profile
        if req.query_text:
            strengthen_profile(req.query_text, boost=1.0)

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
                    evidence_ids = json.loads(answer_row["evidence_refs"] or "[]")
                    # evidence_refs are source_refs, not IDs — try to resolve
                    if evidence_ids and isinstance(evidence_ids[0], str):
                        evidence_ids = []  # Can't resolve refs to IDs easily
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


# ── Source preview ──

@app.get("/source")
def api_source(ref: str = Query(..., description="source_ref like raw.md:line:5:line")) -> dict:
    """Return raw file content around the referenced line for source preview."""
    parts = ref.split(":")
    if len(parts) < 3:
        raise HTTPException(status_code=400, detail="Invalid source_ref format")

    filename = parts[0]
    try:
        line_no = int(parts[2])
    except (ValueError, IndexError):
        line_no = 1

    # Find the actual file path from chunks
    with connect() as conn:
        row = conn.execute(
            "SELECT source_file FROM chunks WHERE source_ref = ? LIMIT 1", (ref,)
        ).fetchone()

    if not row:
        raise HTTPException(status_code=404, detail="Source not found")

    try:
        import pathlib
        content = pathlib.Path(row["source_file"]).read_text(encoding="utf-8", errors="ignore")
        lines = content.splitlines()

        # Return context: 5 lines before and after the target line
        ctx_start = max(0, line_no - 6)
        ctx_end = min(len(lines), line_no + 5)
        context_lines = [
            {"line": i + 1, "text": lines[i], "highlight": i + 1 == line_no}
            for i in range(ctx_start, ctx_end)
        ]

        return {
            "file": row["source_file"],
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


# ── Special Knowledge Ingest ──

class SpecialIngestRequest(BaseModel):
    folder_path: str
    topic_name: str | None = None


@app.post("/special-ingest")
def api_special_ingest(req: SpecialIngestRequest) -> dict:
    """Ingest a folder as a specialknowledge topic."""
    from app.special_ingest import ingest_folder
    try:
        return ingest_folder(req.folder_path, topic_name=req.topic_name)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/special-knowledge")
def api_special_knowledge() -> dict:
    """List all specialknowledge topics."""
    with connect() as conn:
        rows = conn.execute(
            "SELECT id, topic_name, summary, source_file, created_at FROM tag_segments WHERE tag = 'specialknowledge' ORDER BY created_at DESC"
        ).fetchall()
        # Count chunks per topic source
        chunk_counts = {}
        for row in conn.execute(
            "SELECT source_file, COUNT(1) c FROM chunks WHERE dimension = 'specialknowledge' GROUP BY source_file"
        ).fetchall():
            # Map to folder
            chunk_counts[row["source_file"]] = chunk_counts.get(row["source_file"], 0) + row["c"]
    topics = []
    seen = set()
    for r in rows:
        if r["topic_name"] in seen:
            continue
        seen.add(r["topic_name"])
        topics.append({
            "id": r["id"],
            "topic": r["topic_name"],
            "summary": r["summary"],
            "folder": r["source_file"],
            "created_at": r["created_at"],
        })
    return {"topics": topics}


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

@app.get("/search/history")
def api_search_history() -> dict:
    with connect() as conn:
        rows = conn.execute(
            "SELECT id, query_text, result_count, tag_filter, created_at FROM search_history ORDER BY created_at DESC LIMIT 20"
        ).fetchall()
    return {
        "history": [
            {"id": r["id"], "query": r["query_text"], "result_count": r["result_count"], "tag_filter": r["tag_filter"], "created_at": r["created_at"]}
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
            {"day": r["day"], "tag": r["tag"], "count": r["c"]}
            for r in growth
        ],
    }


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

    import pathlib
    try:
        content = pathlib.Path(row["source_file"]).read_text(encoding="utf-8", errors="ignore")
        all_lines = content.splitlines()
        start = max(0, row["line_start"] - 1)
        end = min(len(all_lines), row["line_end"])
        return {
            "file": row["source_file"],
            "line_start": row["line_start"],
            "line_end": row["line_end"],
            "lines": [
                {"line": i + 1, "text": all_lines[i]}
                for i in range(start, end)
            ],
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
