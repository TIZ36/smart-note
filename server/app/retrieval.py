"""Hybrid search with recall-first strategy.

Principle: 先全再准 — cast a wide net (allow redundancy), then rank by relevance.

6 retrieval paths (all contribute to recall):
  1. FTS5 (jieba segmented) — Chinese word-level matches
  2. LIKE substring — raw substring scan, catches anything FTS misses
  3. Character n-gram overlap — fuzzy partial matches
  4. Vector cosine — semantic similarity
  5. Keyword match — AI-extracted keyword overlap
  6. Tag metadata — segment topic/summary/keyword matching

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


# ── Query embedding cache ──
# Short-TTL (5 min) so repeat queries (follow-up refines, pagination, UI
# debounce) skip the ~85ms HTTP round-trip to the embed endpoint. Keyed on
# the exact query string — safe because embeddings are deterministic.
_QUERY_EMBED_CACHE: dict[str, tuple[float, list[float]]] = {}
_QUERY_EMBED_TTL = 300.0
_QUERY_EMBED_MAX = 256  # LRU-ish: evict oldest when over cap


def _cached_query_embed(query: str) -> list[float]:
    key = query.strip()
    if not key:
        return embed_texts([query])[0]
    now = time.time()
    hit = _QUERY_EMBED_CACHE.get(key)
    if hit and hit[0] > now:
        return hit[1]
    v = embed_texts([query])[0]
    _QUERY_EMBED_CACHE[key] = (now + _QUERY_EMBED_TTL, v)
    if len(_QUERY_EMBED_CACHE) > _QUERY_EMBED_MAX:
        # Drop entries whose TTL has already expired first; if none expired,
        # drop the item with the earliest expiry (≈ oldest).
        expired = [k for k, (exp, _) in _QUERY_EMBED_CACHE.items() if exp <= now]
        for k in expired:
            _QUERY_EMBED_CACHE.pop(k, None)
        if len(_QUERY_EMBED_CACHE) > _QUERY_EMBED_MAX:
            oldest = min(_QUERY_EMBED_CACHE.items(), key=lambda kv: kv[1][0])[0]
            _QUERY_EMBED_CACHE.pop(oldest, None)
    return v


def _vector_rank(qv: list[float], all_rows) -> list[tuple[float, object]]:
    """Rank rows by cosine(qv, row_embedding) using int8 matmul when
    available. Returns sorted (score, row) pairs, highest first."""
    if not all_rows or not qv:
        return []
    try:
        import numpy as np
    except ImportError:
        # Fallback: python cosine + JSON parse (the slow path we are leaving).
        scored = []
        for row in all_rows:
            emb_json = row["embedding_json"] if "embedding_json" in row.keys() else None
            if not emb_json:
                continue
            scored.append((_cosine(qv, json.loads(emb_json)), row))
        scored.sort(key=lambda x: x[0], reverse=True)
        return scored

    # Quantize the query once (same scheme as stored rows).
    qv_np = np.asarray(qv, dtype=np.float32)
    q_max = float(np.abs(qv_np).max())
    if q_max < 1e-9:
        return []
    q_i8 = np.clip(np.round(qv_np / q_max * 127), -128, 127).astype(np.int8)
    q_i32 = q_i8.astype(np.int32)
    q_norm = float(np.sqrt((q_i32 * q_i32).sum()))
    if q_norm < 1e-9:
        return []

    # Bucket rows: those with q8 (fast path) vs legacy JSON (fallback).
    q8_rows = []
    q8_mat_list = []
    legacy_rows = []
    for row in all_rows:
        blob = row["embedding_q8"] if "embedding_q8" in row.keys() else None
        if blob and len(blob) == q_i8.size:
            q8_rows.append(row)
            q8_mat_list.append(np.frombuffer(blob, dtype=np.int8))
        else:
            emb_json = row["embedding_json"] if "embedding_json" in row.keys() else None
            if emb_json:
                legacy_rows.append(row)

    scored: list[tuple[float, object]] = []
    if q8_mat_list:
        M = np.stack(q8_mat_list).astype(np.int32)
        norms = np.sqrt((M * M).sum(axis=1).astype(np.float64))
        norms[norms < 1e-9] = 1.0
        dots = (M @ q_i32).astype(np.float64)
        sims = dots / (norms * q_norm)
        for r, s in zip(q8_rows, sims):
            scored.append((float(s), r))

    if legacy_rows:
        for r in legacy_rows:
            try:
                scored.append((_cosine(qv, json.loads(r["embedding_json"])), r))
            except (json.JSONDecodeError, TypeError):
                continue

    scored.sort(key=lambda x: x[0], reverse=True)
    return scored


def _expand_query_via_meta_memory(query: str) -> tuple[str, list[str]]:
    """A1: augment the raw query string with domain vocabulary Claude has
    previously taught the system. Relevant entries (vocab/rule/alias kinds)
    whose text contains a substring of the query OR vice versa get appended
    as extra terms the multi-path retrieval can match on.

    Returns (expanded_query, applied_memories).
    """
    if not query or not query.strip():
        return query, []
    q_low = query.lower()
    applied: list[str] = []
    extras: list[str] = []
    hit_ids: list[int] = []
    try:
        with connect() as conn:
            rows = conn.execute(
                "SELECT id, text, kind FROM meta_memory "
                "WHERE kind IN ('vocab', 'alias', 'rule') "
                "ORDER BY hit_count DESC LIMIT 50"
            ).fetchall()
        for r in rows:
            txt = (r["text"] or "").lower()
            # Heuristic: if the memory text mentions a keyword from the query,
            # add the memory's terms as expansion candidates.
            hit = False
            for tok in q_low.split():
                if len(tok) >= 2 and tok in txt:
                    hit = True
                    break
            if not hit:
                continue
            applied.append(r["text"])
            hit_ids.append(r["id"])
            # Extract the "right-hand side" — things that look like identifiers
            # (CamelCase, snake_case, table names, English words ≥3 chars).
            for m in re.finditer(r"[A-Za-z_][A-Za-z0-9_]{2,}", r["text"]):
                term = m.group(0)
                if term.lower() not in q_low and term not in extras:
                    extras.append(term)
        # Batch the hit_count bump — single UPDATE + one connection instead
        # of N connection-per-match cycles.
        if hit_ids:
            try:
                ph = ",".join("?" for _ in hit_ids)
                with connect() as conn:
                    conn.execute(
                        f"UPDATE meta_memory SET hit_count = hit_count + 1 "
                        f"WHERE id IN ({ph})",
                        hit_ids,
                    )
                    conn.commit()
            except Exception:
                pass
    except Exception:
        return query, []
    if not extras:
        return query, applied
    expanded = query + " " + " ".join(extras[:8])  # cap to avoid runaway
    return expanded, applied


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
    return overlap / len(q_grams)


def _substring_score(query: str, text: str) -> float:
    """Score based on substring containment, normalized by coverage."""
    q = query.lower().strip()
    t = text.lower().strip()
    if not q or not t:
        return 0.0
    # Exact substring match — score by coverage (short query in long text = weaker)
    if q in t:
        coverage = len(q) / max(len(t), 1)
        return 0.7 + 0.3 * min(coverage * 10, 1.0)  # 0.7–1.0 range
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


def _fts_rank_score(rank_position: int, total_fts: int) -> float:
    """Convert FTS result position to a 0-1 score (higher is better)."""
    if total_fts <= 1:
        return 1.0
    return max(0.0, 1.0 - (rank_position / total_fts))


# ── Main search ──────────────────────────────────────────────────

def search(query: str, topk: int = 5, tag_filter: str | None = None, include_wiki: list[str] | None = None) -> dict:
    start = time.time()

    # A1: expand query with synonyms/aliases Claude has written into meta_memory.
    expanded_query, applied_memories = _expand_query_via_meta_memory(query)
    # Embed the ORIGINAL query for semantic similarity (the expansion only
    # helps lexical paths — FTS/substring/keyword). Otherwise expansion noise
    # would pollute vector similarity. Uses a short-TTL cache for repeat
    # queries.
    qv = _cached_query_embed(query)
    q_lower = expanded_query.lower().strip()

    # Segment query with jieba for FTS matching — uses the expanded form so
    # new synonym terms contribute to token-level retrieval.
    q_segmented = segment_query(expanded_query)
    q_tokens = set(q_segmented.split())

    # Get adaptive weights BEFORE opening the main search connection
    weights = get_adaptive_weights(query)

    # Recall Q&A memories — may override weights if similar question found
    qa_mem = recall_qa_memories(query)
    if qa_mem["params"]:
        learned = qa_mem["params"]["weights"]
        sim = qa_mem["params"]["similarity"]
        for key in weights:
            if key in learned:
                weights[key] = sim * learned[key] + (1 - sim) * weights[key]

    pool_size = topk * 10

    with connect() as conn:
        # Tag filter + wiki clause
        tag_clause = ""
        tag_params: list = []
        if tag_filter:
            tag_clause = " AND c.dimension = ?"
            tag_params = [tag_filter]
        elif include_wiki:
            wiki_dims = [f"wiki:{s}" for s in include_wiki]
            placeholders = ",".join("?" for _ in wiki_dims)
            tag_clause = f" AND (c.dimension NOT LIKE 'wiki:%' OR c.dimension IN ({placeholders}))"
            tag_params = wiki_dims

        # ── Path 1: FTS5 (jieba segmented tokens) ──
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
                    [q_segmented, *tag_params, pool_size],
                ).fetchall()
            except Exception:
                pass

        # ── Path 2: LIKE substring scan ──
        like_rows = []
        if tag_filter:
            tag_where = " AND dimension = ?"
            tag_where_params = [tag_filter]
        elif include_wiki:
            wiki_dims = [f"wiki:{s}" for s in include_wiki]
            placeholders = ",".join("?" for _ in wiki_dims)
            tag_where = f" AND (dimension NOT LIKE 'wiki:%' OR dimension IN ({placeholders}))"
            tag_where_params = list(wiki_dims)
        else:
            tag_where = ""
            tag_where_params = []

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
                    [like_pattern, like_pattern, like_pattern, *tag_where_params, pool_size],
                ).fetchall()
            except Exception:
                pass

            words = [w for w in re.split(r'\s+', q_lower) if len(w) >= 2]
            for word in words[:5]:
                try:
                    word_rows = conn.execute(
                        f"SELECT id, text, source_ref, dimension, keywords_json, ai_summary FROM chunks WHERE text LIKE ?{tag_where} LIMIT ?",
                        [f"%{word}%", *tag_where_params, pool_size // 2],
                    ).fetchall()
                    like_rows.extend(word_rows)
                except Exception:
                    pass

        # ── Path 3 + 4: Vector + n-gram (scan chunks) ──
        if tag_filter:
            all_rows = conn.execute(
                "SELECT id, text, source_ref, dimension, embedding_json, keywords_json, ai_summary FROM chunks WHERE dimension = ?",
                (tag_filter,),
            ).fetchall()
        elif include_wiki:
            wiki_dims = [f"wiki:{s}" for s in include_wiki]
            placeholders = ",".join("?" for _ in wiki_dims)
            all_rows = conn.execute(
                f"SELECT id, text, source_ref, dimension, embedding_q8, embedding_scale, embedding_json, keywords_json, ai_summary FROM chunks WHERE dimension NOT LIKE 'wiki:%' OR dimension IN ({placeholders})",
                wiki_dims,
            ).fetchall()
        else:
            all_rows = conn.execute(
                "SELECT id, text, source_ref, dimension, embedding_q8, embedding_scale, embedding_json, keywords_json, ai_summary FROM chunks"
            ).fetchall()

        # Vector path: use int8 BLOB matmul (numpy) — kills JSON parse and
        # Python cosine loop, the twin hotspots that dominated /search time.
        # Falls back to legacy float32 JSON path for any rows without q8.
        vec_scored = _vector_rank(qv, all_rows)

        # ── Path 6: Tag metadata match ──
        # Build a line-range index for efficient segment→chunk matching
        from app.builds import get_active_build_id as _get_active_build
        active_build = _get_active_build()
        tag_meta_boost: dict[int, float] = {}
        tag_meta_chunks: list[tuple[float, object]] = []

        # Index chunks by (source_file_prefix, line_start) for fast segment matching
        chunk_line_index: dict[int, tuple[str, int]] = {}
        for row in all_rows:
            ref = row["source_ref"]
            try:
                parts = ref.split(":")
                if len(parts) >= 3:
                    line_no = int(parts[2].split("-")[0])
                    chunk_line_index[row["id"]] = (":".join(parts[:2]), line_no)
            except (ValueError, IndexError):
                pass

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

            # Also include wiki tag_segments (they have separate build_ids)
            wiki_seg_rows = conn.execute(
                "SELECT tag, topic_name, summary, keywords_json, line_start, line_end FROM tag_segments WHERE tag LIKE 'wiki:%'"
            ).fetchall()
            # Deduplicate by combining
            seg_seen = {(s["tag"], s["line_start"], s["line_end"]) for s in seg_rows}
            for ws in wiki_seg_rows:
                key = (ws["tag"], ws["line_start"], ws["line_end"])
                if key not in seg_seen:
                    seg_rows = list(seg_rows) + [ws]
                    seg_seen.add(key)

            for seg in seg_rows:
                meta_text = f"{seg['topic_name']} {seg['summary']} {seg['tag']}"
                kws = _safe_json_list(seg["keywords_json"])
                meta_text += " " + " ".join(kws)

                # Use keyword overlap + substring for metadata scoring
                kw_score = _keyword_score(q_tokens, kws) if kws else 0.0
                sub_score = _substring_score(query, meta_text)
                seg_score = max(kw_score, sub_score * 0.6 + _ngram_score(query, meta_text) * 0.4)

                if seg_score > 0.15:
                    # Match chunks in this segment's line range
                    for rid, (prefix, line_no) in chunk_line_index.items():
                        if seg["line_start"] <= line_no <= seg["line_end"]:
                            tag_meta_boost[rid] = max(tag_meta_boost.get(rid, 0), seg_score)
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
                    "sub": 0.0,
                    "ngram": 0.0,
                    "vec": 0.0,
                    "kw": 0.0,
                    "tag_meta": 0.0,
                }
            return merged[rid]

        # FTS hits — scored by position (not binary 1.0)
        total_fts = len(fts_rows)
        for rank, row in enumerate(fts_rows):
            item = _ensure(row)
            item["fts"] = max(item["fts"], _fts_rank_score(rank, total_fts))
            kws = _safe_json_list(row["keywords_json"])
            item["kw"] = max(item["kw"], _keyword_score(q_tokens, kws))

        # LIKE hits
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

        # Vector top results
        for score, row in vec_scored[:pool_size]:
            item = _ensure(row)
            item["vec"] = max(item["vec"], score)
            kws = _safe_json_list(row["keywords_json"])
            item["kw"] = max(item["kw"], _keyword_score(q_tokens, kws))

        # N-gram + tag metadata for all candidates
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

        # ── Trust-score boost (self-curation loop) ──
        # Chunks that led to thumbs-up'd answers get a multiplicative boost.
        # Trust decays exponentially with age: half-life ~90 days so stale
        # votes fade naturally instead of perpetually pinning old answers.
        # Also soft-capped at 20 to prevent runaway.
        trust_map: dict[int, float] = {}
        if merged:
            ids = list(merged.keys())
            ph = ",".join("?" for _ in ids)
            for tr in conn.execute(
                f"SELECT id, trust_score, "
                f"       CAST((julianday('now') - julianday("
                f"           COALESCE((SELECT MAX(f.created_at) FROM feedback_logs f "
                f"                     JOIN answer_logs a ON a.id = f.answer_id "
                f"                     WHERE a.evidence_refs LIKE '%' || c.id || '%'), "
                f"                    c.created_at))) AS REAL) AS age_days "
                f"FROM chunks c WHERE id IN ({ph})",
                ids,
            ).fetchall():
                raw_trust = float(tr["trust_score"] or 0)
                age = float(tr["age_days"] or 0)
                # half-life 90 days → lambda = ln(2)/90
                import math as _math
                decayed = raw_trust * _math.exp(-0.00770 * max(0.0, age))
                # Cap at ±20 after decay
                trust_map[tr["id"]] = max(-20.0, min(20.0, decayed))

        # ── Final scoring (no dead "mem" weight — redistributed to kw and tag_meta) ──
        results = list(merged.values())
        for item in results:
            base = (
                weights.get("fts", 0.15) * item["fts"]
                + weights.get("sub", 0.13) * item["sub"]
                + weights.get("ngram", 0.05) * item["ngram"]
                + weights.get("vec", 0.20) * item["vec"]
                + weights.get("kw", 0.12) * item["kw"]
                + weights.get("tag_meta", 0.30) * item["tag_meta"]
                + positive_bias
            )
            trust = trust_map.get(item["id"], 0.0)
            # Multiplicative: trust=0 → no change; trust=5 → +25%; trust=10 → +50%.
            trust_boost = 1.0 + 0.05 * max(-3.0, min(10.0, trust))
            item["score"] = base * trust_boost
            item["trust_score"] = trust
            # A2: preserve per-path contributions so the feedback handler can
            # nudge weights toward whichever path actually drove this hit.
            item["path_breakdown"] = {
                "fts": item["fts"], "sub": item["sub"], "ngram": item["ngram"],
                "vec": item["vec"], "kw": item["kw"], "tag_meta": item["tag_meta"],
            }

        results.sort(key=lambda x: x["score"], reverse=True)

        # C3: cross-source ensemble bonus. If the top topk's dimensions span
        # BOTH note and wiki, add a small boost to chunks whose dimension
        # agrees with another source's top chunk on the same topic area.
        _apply_ensemble_bonus(results[: topk * 2])
        results.sort(key=lambda x: x["score"], reverse=True)

        recall_results = results[:topk * 2]
        evidence_ids = [r["id"] for r in recall_results if isinstance(r["id"], int)]

        results = results[:topk]

        # Mark wiki results + collect wiki topics found
        wiki_topics_found: dict[str, int] = {}
        for item in results:
            dim = item.get("dimension", "")
            if dim.startswith("wiki:"):
                item["is_wiki"] = True
                topic = dim[5:]
                wiki_topics_found[topic] = wiki_topics_found.get(topic, 0) + 1
            else:
                item["is_wiki"] = False

        # Consolidate every per-path score into a `path_scores` dict the
        # UI can render as a breakdown tooltip ("FTS 0.8 · vec 0.3 · kw
        # 0.1"). Used to demo 6-path fusion to users who'd otherwise
        # assume this is yet another single-path RAG.
        for item in results:
            item["path_scores"] = {
                "fts":      float(item.get("fts", 0) or 0),
                "sub":      float(item.get("sub", 0) or 0),
                "ngram":    float(item.get("ngram", 0) or 0),
                "vec":      float(item.get("vec", 0) or 0),
                "kw":       float(item.get("kw", 0) or 0),
                "tag_meta": float(item.get("tag_meta", 0) or 0),
            }
            # Pop the raw fields so the top-level object stays tidy —
            # path_scores is the canonical way to read per-path values.
            for k in ("fts", "sub", "ngram", "vec", "kw", "tag_meta"):
                item.pop(k, None)

        # Merge Q&A memory answer hits
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

    # Save query profile AFTER closing the search connection
    try:
        save_query_profile(query, weights, evidence_ids)
    except Exception:
        pass

    return {
        "results": results,
        "latency_ms": latency,
        "total_recall": len(merged),
        "weights_used": weights,
        "is_adaptive": weights != DEFAULT_WEIGHTS,
        "qa_memory_used": qa_mem["params"] is not None or len(qa_mem.get("answer_hits", [])) > 0,
        "wiki_topics_found": wiki_topics_found,
        "query_expansion": {
            "expanded_query": expanded_query if expanded_query != query else None,
            "applied_memories": applied_memories,
        },
    }


def _apply_ensemble_bonus(results: list[dict], boost: float = 0.08) -> None:
    """C3: cross-source ensemble. When the recall set contains BOTH note
    chunks and wiki chunks in the top-N, add a mild multiplicative boost to
    every chunk — as a reward for multi-source corroboration. Also stamp an
    `ensemble` flag so the UI can render "corroborated by note + wiki"."""
    has_note = any(not (r.get("dimension") or "").startswith("wiki:") for r in results)
    has_wiki = any((r.get("dimension") or "").startswith("wiki:") for r in results)
    if not (has_note and has_wiki):
        return
    for r in results:
        r["score"] = r.get("score", 0) * (1.0 + boost)
        r["ensemble"] = True


def _safe_json_list(raw: str | None) -> list[str]:
    if not raw:
        return []
    try:
        parsed = json.loads(raw)
        return parsed if isinstance(parsed, list) else []
    except (json.JSONDecodeError, TypeError):
        return []
