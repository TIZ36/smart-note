"""Hybrid search with recall-first strategy.

Principle: 先全再准 — cast a wide net (allow redundancy), then rank by relevance.

5 retrieval paths (all contribute to recall):
  1. FTS5 (jieba segmented) — Chinese word-level matches
  2. LIKE substring — raw substring scan, catches anything FTS misses
  3. Character n-gram overlap — fuzzy partial matches
  4. Vector cosine — semantic similarity
  5. Keyword match — AI-extracted keyword overlap

All paths dump into a merged pool → score → sort → return topk.
"""

from __future__ import annotations

import json
import math
import re
import time

from app.adaptive import get_adaptive_weights, save_query_profile, DEFAULT_WEIGHTS
from app.db import connect
from app.embed import embed_texts
from app.memory import recall_qa_memories
from app.tokenizer import segment_query


# ── Scoring helpers ──────────────────────────────────────────────

def _cosine(a: list[float], b: list[float]) -> float:
    if not a or not b:
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)


def _char_ngrams(text: str, n: int = 2) -> set[str]:
    """Extract character-level n-grams from text."""
    t = text.lower().replace(" ", "")
    if len(t) < n:
        return {t} if t else set()
    return {t[i:i + n] for i in range(len(t) - n + 1)}


def _ngram_score(query: str, text: str) -> float:
    """Character bigram overlap ratio (Jaccard-like)."""
    q_grams = _char_ngrams(query)
    t_grams = _char_ngrams(text)
    if not q_grams or not t_grams:
        return 0.0
    overlap = len(q_grams & t_grams)
    return overlap / len(q_grams)  # recall-oriented: how many query grams are found


def _substring_score(query: str, text: str) -> float:
    """Score based on substring containment."""
    q = query.lower().strip()
    t = text.lower().strip()
    if not q or not t:
        return 0.0
    # Exact substring match is strong signal
    if q in t:
        return 1.0
    # Check each query word individually
    words = [w for w in re.split(r'\s+', q) if len(w) > 1]
    if not words:
        return 0.0
    hits = sum(1 for w in words if w in t)
    return hits / len(words)


def _keyword_score(query_tokens: set[str], chunk_keywords: list[str]) -> float:
    """Score based on keyword overlap."""
    if not query_tokens or not chunk_keywords:
        return 0.0
    kw_set = {k.lower() for k in chunk_keywords}
    overlap = len(query_tokens & kw_set)
    return min(overlap / max(len(query_tokens), 1), 1.0)


# ── Main search ──────────────────────────────────────────────────

def search(query: str, topk: int = 5, tag_filter: str | None = None, include_spkn: list[str] | None = None) -> dict:
    start = time.time()
    qv = embed_texts([query])[0]
    q_lower = query.lower().strip()

    # Segment query with jieba for FTS matching
    q_segmented = segment_query(query)
    q_tokens = set(q_segmented.split())

    # Get adaptive weights BEFORE opening the main search connection
    weights = get_adaptive_weights(query)

    # Recall Q&A memories — may override weights if similar question found
    qa_mem = recall_qa_memories(query)
    if qa_mem["params"]:
        # Similar question found — blend its weights (stronger than adaptive alone)
        learned = qa_mem["params"]["weights"]
        sim = qa_mem["params"]["similarity"]
        for key in weights:
            if key in learned:
                weights[key] = sim * learned[key] + (1 - sim) * weights[key]

    # Wider pool: aim for topk * 10 candidates before final ranking
    pool_size = topk * 10

    with connect() as conn:
        # Tag filter + spkn exclusion clause
        # Default: exclude all spkn:* dimensions unless explicitly included
        tag_clause = ""
        tag_params: list = []
        if tag_filter:
            tag_clause = " AND c.dimension = ?"
            tag_params = [tag_filter]
        elif include_spkn:
            # Include note chunks + selected spkn topics
            spkn_dims = [f"spkn:{s}" for s in include_spkn]
            placeholders = ",".join("?" for _ in spkn_dims)
            tag_clause = f" AND (c.dimension NOT LIKE 'spkn:%' OR c.dimension IN ({placeholders}))"
            tag_params = spkn_dims
        else:
            # Default: exclude all spkn
            tag_clause = " AND c.dimension NOT LIKE 'spkn:%'"

        # ── Path 1: FTS5 (jieba segmented tokens) ──
        fts_ids: set[int] = set()
        fts_rows = []
        if q_segmented.strip():
            try:
                fts_rows = conn.execute(
                    f"""
                    SELECT c.id, c.text, c.source_ref, c.dimension,
                           c.keywords_json, c.ai_summary
                    FROM chunks_fts f
                    JOIN chunks c ON c.id = f.rowid
                    WHERE chunks_fts MATCH ?{tag_clause}
                    LIMIT ?
                    """,
                    [q_segmented] + tag_params + [pool_size],
                ).fetchall()
                fts_ids = {r["id"] for r in fts_rows}
            except Exception:
                pass

        # ── Path 2: LIKE substring scan ──
        like_rows = []
        if tag_filter:
            tag_where = f" AND dimension = '{tag_filter}'"
        elif include_spkn:
            spkn_in = ",".join(f"'spkn:{s}'" for s in include_spkn)
            tag_where = f" AND (dimension NOT LIKE 'spkn:%' OR dimension IN ({spkn_in}))"
        else:
            tag_where = " AND dimension NOT LIKE 'spkn:%'"
        if len(q_lower) >= 2:
            like_pattern = f"%{q_lower}%"
            try:
                like_rows = conn.execute(
                    f"""
                    SELECT id, text, source_ref, dimension, keywords_json, ai_summary
                    FROM chunks
                    WHERE (text LIKE ? OR keywords_json LIKE ? OR ai_summary LIKE ?){tag_where}
                    LIMIT ?
                    """,
                    (like_pattern, like_pattern, like_pattern, pool_size),
                ).fetchall()
            except Exception:
                pass

            words = [w for w in re.split(r'\s+', q_lower) if len(w) >= 2]
            for word in words[:5]:
                try:
                    word_rows = conn.execute(
                        f"SELECT id, text, source_ref, dimension, keywords_json, ai_summary FROM chunks WHERE text LIKE ?{tag_where} LIMIT ?",
                        (f"%{word}%", pool_size // 2),
                    ).fetchall()
                    like_rows.extend(word_rows)
                except Exception:
                    pass

        # ── Path 3 + 4: Vector + n-gram (scan all chunks with spkn filter) ──
        if tag_filter:
            all_rows = conn.execute(
                "SELECT id, text, source_ref, dimension, embedding_json, keywords_json, ai_summary FROM chunks WHERE dimension = ?",
                (tag_filter,),
            ).fetchall()
        elif include_spkn:
            spkn_in = ",".join(f"'spkn:{s}'" for s in include_spkn)
            all_rows = conn.execute(
                f"SELECT id, text, source_ref, dimension, embedding_json, keywords_json, ai_summary FROM chunks WHERE dimension NOT LIKE 'spkn:%' OR dimension IN ({spkn_in})"
            ).fetchall()
        else:
            all_rows = conn.execute(
                "SELECT id, text, source_ref, dimension, embedding_json, keywords_json, ai_summary FROM chunks WHERE dimension NOT LIKE 'spkn:%'"
            ).fetchall()

        vec_scored = []
        for row in all_rows:
            emb_json = row["embedding_json"]
            if emb_json:
                score = _cosine(qv, json.loads(emb_json))
                vec_scored.append((score, row))
        vec_scored.sort(key=lambda x: x[0], reverse=True)

        # Path 5: Q&A memory answer hits (from recall_qa_memories above)

        # ── Path 6: Tag metadata match (topic_name, summary, keywords) ──
        # Match query against tag_segments' AI-enriched metadata.
        # If a segment matches, ALL its covered chunks are added to the pool
        # (not just boosted — this is a recall path, not just a boost).
        from app.builds import get_active_build_id as _get_active_build
        active_build = _get_active_build()
        tag_meta_boost: dict[int, float] = {}
        tag_meta_chunks: list[tuple[float, object]] = []  # (score, row) for chunks found via metadata
        try:
            if active_build:
                seg_rows = conn.execute(
                    "SELECT tag, topic_name, summary, keywords_json, line_start, line_end FROM tag_segments WHERE build_id = ?",
                    (active_build,),
                ).fetchall()
            else:
                seg_rows = conn.execute(
                    "SELECT tag, topic_name, summary, keywords_json, line_start, line_end FROM tag_segments"
                ).fetchall()

            for seg in seg_rows:
                meta_text = f"{seg['topic_name']} {seg['summary']} {seg['tag']}"
                kws = []
                try:
                    kws = json.loads(seg["keywords_json"]) if seg["keywords_json"] else []
                except Exception:
                    pass
                meta_text += " " + " ".join(kws)

                seg_score = _substring_score(query, meta_text) * 0.6 + _ngram_score(query, meta_text) * 0.4
                if seg_score > 0.15:
                    for row in all_rows:
                        ref = row["source_ref"]
                        try:
                            parts = ref.split(":")
                            if len(parts) >= 3:
                                line_no = int(parts[2].split("-")[0])
                                if seg["line_start"] <= line_no <= seg["line_end"]:
                                    rid = row["id"]
                                    tag_meta_boost[rid] = max(tag_meta_boost.get(rid, 0), seg_score)
                                    tag_meta_chunks.append((seg_score, row))
                        except (ValueError, IndexError):
                            pass
        except Exception:
            pass

        # ── Merge all paths into candidate pool ──
        merged: dict[int, dict] = {}

        def _ensure(row) -> dict:
            rid = row["id"]
            if rid not in merged:
                merged[rid] = {
                    "id": rid,
                    "text": row["text"],
                    "source_ref": row["source_ref"],
                    "dimension": row["dimension"],
                    "fts": 0.0,
                    "sub": 0.0,    # substring score
                    "ngram": 0.0,  # character n-gram score
                    "vec": 0.0,
                    "kw": 0.0,
                    "mem": 0.0,
                    "tag_meta": 0.0,
                }
            return merged[rid]

        # FTS hits
        for row in fts_rows:
            item = _ensure(row)
            item["fts"] = 1.0
            kws = _safe_json_list(row["keywords_json"])
            item["kw"] = max(item["kw"], _keyword_score(q_tokens, kws))

        # LIKE hits — compute substring score
        seen_like: set[int] = set()
        for row in like_rows:
            rid = row["id"]
            if rid in seen_like:
                continue
            seen_like.add(rid)
            item = _ensure(row)
            item["sub"] = max(item["sub"], _substring_score(query, row["text"]))
            kws = _safe_json_list(row["keywords_json"])
            item["kw"] = max(item["kw"], _keyword_score(q_tokens, kws))

        # Vector top results + n-gram scoring for all candidates
        for score, row in vec_scored[:pool_size]:
            item = _ensure(row)
            item["vec"] = max(item["vec"], score)
            kws = _safe_json_list(row["keywords_json"])
            item["kw"] = max(item["kw"], _keyword_score(q_tokens, kws))

        # Tag metadata recall: add chunks found via segment metadata match
        for seg_score, row in tag_meta_chunks:
            item = _ensure(row)
            item["tag_meta"] = max(item.get("tag_meta", 0), seg_score)

        # N-gram score + tag metadata boost for all candidates
        for rid, item in merged.items():
            item["ngram"] = _ngram_score(query, item["text"])
            item["tag_meta"] = max(item.get("tag_meta", 0), tag_meta_boost.get(rid, 0.0))

        # ── Feedback bias ──
        positive_bias = 0.0
        fb_count = conn.execute(
            "SELECT COUNT(1) c FROM feedback_logs WHERE feedback_type='plus_one'"
        ).fetchone()["c"]
        if fb_count > 0:
            positive_bias = min(0.15, 0.01 * fb_count)

        # ── Final scoring with adaptive weights ──
        results = list(merged.values())
        for item in results:
            item["score"] = (
                weights.get("fts", 0.18) * item["fts"]
                + weights.get("sub", 0.17) * item["sub"]
                + weights.get("ngram", 0.08) * item["ngram"]
                + weights.get("vec", 0.22) * item["vec"]
                + weights.get("kw", 0.12) * item["kw"]
                + weights.get("tag_meta", 0.15) * item["tag_meta"]
                + weights.get("mem", 0.03) * item["mem"]
                + positive_bias
            )

        results.sort(key=lambda x: x["score"], reverse=True)

        # Save the raw recall scores per path (for profile learning)
        recall_results = results[:topk * 2]  # keep more for rerank stage
        evidence_ids = [r["id"] for r in recall_results if isinstance(r["id"], int)]

        results = results[:topk]

        # Record per-path contribution for this query (which paths actually hit)
        path_contrib = {}
        for key in ("fts", "sub", "ngram", "vec", "kw", "tag_meta", "mem"):
            vals = [item.get(key, 0) for item in recall_results if item.get(key, 0) > 0]
            path_contrib[key] = len(vals) / max(len(recall_results), 1)

        # Clean up internal scoring fields for response
        for item in results:
            for k in ("sub", "ngram", "tag_meta"):
                item.pop(k, None)

        # ── Path 6: Query profile memory (past successful Q&A) ──
        profile_rows = conn.execute(
            """
            SELECT query_text, evidence_ids_json, feedback_score
            FROM query_profiles
            WHERE feedback_score > 0
            ORDER BY feedback_score DESC
            LIMIT 10
            """,
        ).fetchall()

        # Merge Q&A memory answer hits (pre-scored by query similarity)
        for hit in qa_mem.get("answer_hits", []):
            results.append(hit)
        results.sort(key=lambda x: x.get("score", 0), reverse=True)
        results = results[:topk]

        latency = int((time.time() - start) * 1000)
        conn.execute(
            "INSERT INTO query_logs(query_text, retrieval_mode, topk, latency_ms) VALUES(?, ?, ?, ?)",
            (query, "hybrid-adaptive", topk, latency),
        )
        conn.commit()

    # Save query profile AFTER closing the search connection (avoids "database is locked")
    try:
        save_query_profile(query, weights, evidence_ids)
    except Exception:
        pass  # Don't fail search if profile save fails

    return {
        "results": results,
        "latency_ms": latency,
        "total_recall": len(merged),
        "weights_used": weights,
        "is_adaptive": weights != DEFAULT_WEIGHTS,
        "qa_memory_used": qa_mem["params"] is not None or len(qa_mem.get("answer_hits", [])) > 0,
    }


def _safe_json_list(raw: str | None) -> list[str]:
    if not raw:
        return []
    try:
        parsed = json.loads(raw)
        return parsed if isinstance(parsed, list) else []
    except (json.JSONDecodeError, TypeError):
        return []
