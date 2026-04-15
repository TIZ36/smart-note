from __future__ import annotations

import json
import time
from pathlib import Path

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
from app.rerank import rerank
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


app = FastAPI(title="SmartNote Gateway")

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
    source_files: list[str] = []  # Full source files for deep context (populated by frontend from prior response)
    topk: int = 15


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
    result = search(req.query, req.topk, tag_filter=req.tag_filter, include_wiki=req.include_wiki or None)

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
    result = rerank(req.query, req.result_ids, use_llm=req.use_llm, topk=req.topk)
    return result


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


def _read_full_source(source_file: str) -> str:
    """Read full text of a source file."""
    p = Path(source_file)
    if not p.exists():
        return ""
    try:
        text = p.read_text(encoding="utf-8", errors="ignore")
        if len(text) > 50000:
            text = text[:50000] + f"\n\n[... truncated, {len(text) - 50000} more chars ...]"
        return text
    except Exception:
        return ""


@app.post("/chat")
def api_chat(req: ChatRequest) -> dict:
    """Unified AI chat — first call returns quick answer + source_files cache.
    Follow-ups with source_files get deep context from full documents."""
    start = time.time()

    # Load evidence chunks
    if req.evidence_ids:
        with connect() as conn:
            placeholders = ",".join("?" for _ in req.evidence_ids)
            rows = conn.execute(
                f"SELECT id, text, source_ref, source_file, dimension FROM chunks WHERE id IN ({placeholders})",
                req.evidence_ids,
            ).fetchall()
        evidence = [dict(r) for r in rows]
    else:
        sr = search(req.query, req.topk)
        evidence = sr["results"]

    # Build evidence text for the prompt
    evidence_lines = []
    for i, e in enumerate(evidence):
        text = (e.get("text", "") or "").strip()
        ref = e.get("source_ref", "")
        if text:
            evidence_lines.append(f"[{i+1}] ({ref}) {text}")
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

    try:
        answer = _chat_completion(system, messages)
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
    with connect() as conn:
        qid_row = conn.execute("SELECT id FROM query_logs ORDER BY id DESC LIMIT 1").fetchone()
        qid = qid_row["id"] if qid_row else 0
        conn.execute(
            "INSERT INTO answer_logs(query_id, answer_text, evidence_refs, model_name, latency_ms) VALUES(?, ?, ?, ?, ?)",
            (qid, answer, json.dumps(evidence_ids), settings.provider_chat_model, latency),
        )
        answer_id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
        conn.commit()

    return {
        "answer_id": answer_id,
        "answer": answer,
        "evidence": evidence,
        "latency_ms": latency,
        "source_files": top_source_files,
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


def _read_line_window(path: str | Path, center_line: int, before: int = 5, after: int = 5) -> list[dict]:
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


def _read_lines_inclusive(path: str | Path, line_start: int, line_end: int) -> list[dict]:
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
def api_source(ref: str = Query(..., description="source_ref like raw.md:line:5:line")) -> dict:
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
            topics[topic]["files"].append({
                "path": row["source_file"],
                "chunks": row["chunk_count"],
            })
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
            note_keywords.update(k.lower() for k in kws if isinstance(k, str) and len(k) > 2)
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
            "files": [{"path": r["source_file"], "chunks": r["chunk_count"]} for r in note_file_rows[:5]],
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
                edges.append({
                    "source": id_i,
                    "target": id_j,
                    "similarity": round(sim, 3),
                    "weight": round(sim * 10, 1),
                })

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
        topics.append({
            "id": r["id"],
            "topic": r["topic_name"],
            "summary": r["summary"],
            "folder": r["source_file"],
            "category": category,
            "created_at": r["created_at"],
        })
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
        chunk_del = conn.execute("DELETE FROM chunks WHERE dimension = ?", (dimension,)).rowcount
        seg_del = conn.execute("DELETE FROM tag_segments WHERE tag = ?", (dimension,)).rowcount
        for br in build_rows:
            bid = br["build_id"]
            remaining = conn.execute("SELECT COUNT(1) c FROM chunks WHERE build_id = ?", (bid,)).fetchone()["c"]
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

    return {"deleted": topic_name, "chunks_removed": chunk_del, "segments_removed": seg_del, "files_deleted": files_deleted}


@app.get("/wiki-sources")
def api_wiki_sources() -> dict:
    """List all distinct source .md files from wiki chunks for the Sources panel."""
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
        sources.append({
            "path": abs_path,
            "name": Path(sf).stem,
            "topic": r["topic_name"] or "",
            "category": category,
        })
    return {"sources": sources}


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


@app.post("/wiki/import-url")
def api_wiki_import_url(req: UrlImportRequest) -> dict:
    """Fetch a URL, convert to markdown, and ingest as wiki topic."""
    from app.url_import import import_url
    from app.special_ingest import ingest_folder

    wiki_dir = Path(settings.db_path).resolve().parent / "wiki_sources"
    try:
        result = import_url(req.url, str(wiki_dir), req.topic_name or None)
        md_path = Path(result["md_path"]).resolve()
        # Ingest only the directory containing this specific file
        ingest_result = ingest_folder(str(md_path.parent), topic_name=result["topic_name"])
        return {**ingest_result, "md_path": str(md_path), "source_url": req.url}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ── Wiki Import: MCP Document ──

class McpDocImportRequest(BaseModel):
    server_name: str
    doc_url: str = ""       # Feishu doc URL — auto-extract doc ID
    document_id: str = ""   # Or pass doc ID directly
    topic_name: str = ""


def _extract_feishu_doc_id(url: str) -> str:
    """Extract document ID from Feishu/Lark wiki/doc URL.
    e.g. https://xxx.feishu.cn/wiki/Jt78wVLEJiqPN3kPIorcoOtjngf → Jt78wVLEJiqPN3kPIorcoOtjngf
    """
    import re
    # Match wiki or docx URLs
    m = re.search(r'(?:wiki|docx|docs)/([A-Za-z0-9]+)', url)
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
    """Fetch document from MCP server and ingest as wiki topic."""
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
        wiki_dir = Path(settings.db_path).resolve().parent / "wiki_sources"
        import re as _re
        safe_name = _re.sub(r'[^\w\s\u4e00-\u9fff-]', '_', topic)[:80]
        topic_dir = wiki_dir / safe_name
        topic_dir.mkdir(parents=True, exist_ok=True)
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
