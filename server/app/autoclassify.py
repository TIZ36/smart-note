"""Auto-classification helpers.

Pipeline that reduces Claude's workload on delegate-mode builds. Passes are
ordered cheapest-first so expensive vector math only runs on the residue:

  1. ``auto_inherit_by_hash``  — exact content_hash match against any
     classified chunk. Zero compute, just a SQL lookup. Handles the common
     case of copy-pasted snippets, env blocks, SQL templates.
  2. ``auto_inherit_chunks``   — cosine similarity against segment centroids
     (pre-computed by ``refresh_segment_centroids``). Falls back to
     per-chunk compare if centroids aren't populated yet.
  3. Whatever remains is up to Claude.

Plus ``merge_adjacent_segments`` to keep segment count bounded across many
small incremental submissions.
"""

from __future__ import annotations

import json

from app.db import connect


def _parse_line_no(source_ref: str) -> int | None:
    for part in (source_ref or "").split(":"):
        try:
            n = int(part.split("-")[0])
            if n > 0:
                return n
        except ValueError:
            continue
    return None


def refresh_segment_centroids(build_id: str | None = None) -> int:
    """Compute and store the mean embedding of each tag_segment's covered
    chunks. Uses int8 BLOB column (embedding_q8 + scale) to skip JSON parse
    and cut I/O 4x — the real bottleneck when this was slow.
    """
    try:
        import numpy as np
    except ImportError:
        return 0

    with connect() as conn:
        if build_id:
            seg_rows = conn.execute(
                "SELECT id, source_file, tag, line_start, line_end "
                "FROM tag_segments WHERE build_id = ?",
                (build_id,),
            ).fetchall()
        else:
            seg_rows = conn.execute(
                "SELECT id, source_file, tag, line_start, line_end "
                "FROM tag_segments"
            ).fetchall()
        if not seg_rows:
            return 0

        # Note-side segments have tag_segments.source_file == chunks.source_file.
        # Wiki-side segments store the CONTAINING FOLDER while chunks store
        # the inner .md path. For wiki, group by dimension tag instead.
        note_segs = [s for s in seg_rows if not (s["tag"] or "").startswith("wiki:")]
        wiki_segs = [s for s in seg_rows if (s["tag"] or "").startswith("wiki:")]

        # Load note-side chunks by source_file
        note_source_files = {s["source_file"] for s in note_segs}
        file_to_entries: dict[str, list[tuple[int, bytes, float]]] = {s: [] for s in note_source_files}
        tag_to_entries: dict[str, list[tuple[int, bytes, float]]] = {}

        if note_source_files:
            ph = ",".join("?" for _ in note_source_files)
            chunk_rows = conn.execute(
                f"SELECT source_file, source_ref, embedding_q8, embedding_scale, embedding_json "
                f"FROM chunks WHERE source_file IN ({ph})",
                list(note_source_files),
            ).fetchall()
        else:
            chunk_rows = []

        # Load wiki-side chunks by dimension tag
        if wiki_segs:
            wiki_tags = list({s["tag"] for s in wiki_segs})
            ph2 = ",".join("?" for _ in wiki_tags)
            wiki_chunk_rows = conn.execute(
                f"SELECT dimension, source_ref, embedding_q8, embedding_scale, embedding_json "
                f"FROM chunks WHERE dimension IN ({ph2})",
                wiki_tags,
            ).fetchall()
            for cr in wiki_chunk_rows:
                q8 = cr["embedding_q8"]
                scale = float(cr["embedding_scale"] or 0)
                # line_no isn't meaningful for wiki grouping; use 0 as sentinel
                if q8 and scale > 0:
                    tag_to_entries.setdefault(cr["dimension"], []).append((0, bytes(q8), scale))
                elif cr["embedding_json"]:
                    try:
                        v = json.loads(cr["embedding_json"])
                        if v:
                            max_abs = max(abs(x) for x in v) or 1.0
                            int8 = bytearray(len(v))
                            inv = 127.0 / max_abs
                            for i, x in enumerate(v):
                                iv = max(-128, min(127, int(round(x * inv))))
                                int8[i] = iv & 0xFF
                            tag_to_entries.setdefault(cr["dimension"], []).append((0, bytes(int8), max_abs))
                    except Exception:
                        continue

        for cr in chunk_rows:
            ln = _parse_line_no(cr["source_ref"] or "")
            if ln is None:
                continue
            q8 = cr["embedding_q8"]
            scale = float(cr["embedding_scale"] or 0)
            if q8 and scale > 0:
                file_to_entries[cr["source_file"]].append((ln, bytes(q8), scale))
            elif cr["embedding_json"]:
                # Fallback for any legacy rows lacking q8; quantize on the fly.
                try:
                    v = json.loads(cr["embedding_json"])
                    if v:
                        max_abs = max(abs(x) for x in v) or 1.0
                        int8 = bytearray(len(v))
                        inv = 127.0 / max_abs
                        for i, x in enumerate(v):
                            iv = max(-128, min(127, int(round(x * inv))))
                            int8[i] = iv & 0xFF
                        file_to_entries[cr["source_file"]].append((ln, bytes(int8), max_abs))
                except Exception:
                    continue
        for sf in file_to_entries:
            file_to_entries[sf].sort(key=lambda t: t[0])

        updates: list[tuple[str, int]] = []
        for s in seg_rows:
            is_wiki = (s["tag"] or "").startswith("wiki:")
            if is_wiki:
                # Wiki: all chunks for this dimension are in-scope.
                pick = [(blob, sc) for (_, blob, sc) in tag_to_entries.get(s["tag"], [])]
            else:
                entries = file_to_entries.get(s["source_file"], [])
                if not entries:
                    continue
                ls, le = s["line_start"], s["line_end"]
                pick = [(blob, sc) for (ln, blob, sc) in entries if ls <= ln <= le]
            if not pick:
                continue
            # Stack int8 rows; dequantize per-row (simple float mult).
            dim = len(pick[0][0])
            arr = np.empty((len(pick), dim), dtype=np.float32)
            for i, (blob, sc) in enumerate(pick):
                v = np.frombuffer(blob, dtype=np.int8).astype(np.float32) * (sc / 127.0)
                arr[i] = v
            centroid = arr.mean(axis=0)
            updates.append((json.dumps(centroid.tolist()), s["id"]))

        if updates:
            conn.executemany(
                "UPDATE tag_segments SET centroid_json = ? WHERE id = ?",
                updates,
            )
            conn.commit()
    return len(updates)


def auto_inherit_by_hash(build_id: str, source_file: str) -> dict:
    """Exact-hash pass: for each pending chunk (dimension=""), if any
    classified chunk with the same content_hash exists (in any build,
    any file, with a non-trivial tag), inherit its tag. Zero compute.

    Creates 1-line tag_segments; ``merge_adjacent_segments`` consolidates.
    """
    with connect() as conn:
        pending = conn.execute(
            "SELECT id, source_ref, content_hash FROM chunks "
            "WHERE build_id = ? AND source_file = ? "
            "AND (dimension = '' OR dimension IS NULL) "
            "AND content_hash != ''",
            (build_id, source_file),
        ).fetchall()
        if not pending:
            return {"inherited": 0}

        hashes = list({r["content_hash"] for r in pending})
        # Look up tag per hash (pick the most common tag if multiple match)
        ph = ",".join("?" for _ in hashes)
        rows = conn.execute(
            f"SELECT content_hash, dimension, COUNT(1) c FROM chunks "
            f"WHERE content_hash IN ({ph}) "
            f"AND dimension NOT IN ('', 'others') AND dimension IS NOT NULL "
            f"AND dimension NOT LIKE 'wiki:%' "
            f"GROUP BY content_hash, dimension "
            f"ORDER BY content_hash, c DESC",
            hashes,
        ).fetchall()
        hash_to_tag: dict[str, str] = {}
        for r in rows:
            h = r["content_hash"]
            if h not in hash_to_tag:
                hash_to_tag[h] = r["dimension"]

        if not hash_to_tag:
            return {"inherited": 0}

        inherited = 0
        for p in pending:
            tag = hash_to_tag.get(p["content_hash"])
            if not tag:
                continue
            line_no = _parse_line_no(p["source_ref"] or "")
            if line_no is None:
                continue
            conn.execute("UPDATE chunks SET dimension = ? WHERE id = ?", (tag, p["id"]))
            conn.execute(
                """INSERT INTO tag_segments(build_id, source_file, tag, topic_name,
                   line_start, line_end, summary, keywords_json, entities_json, is_credential)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)""",
                (build_id, source_file, tag, "auto-inherited",
                 line_no, line_no,
                 "Auto-inherited by exact content hash",
                 "[]", "[]"),
            )
            inherited += 1
        conn.commit()

    return {"inherited": inherited}


def auto_inherit_chunks(
    build_id: str,
    source_file: str,
    threshold: float = 0.85,
) -> dict:
    """Cosine-based inherit pass. Matches pending chunks against segment
    CENTROIDS (if available) which is ~50x faster than per-chunk compare
    and empirically more accurate (centroid averages out noisy outliers).
    Falls back to per-chunk compare only if no centroids are populated.
    """
    try:
        import numpy as np
    except ImportError:
        return {"inherited": 0, "skipped_lowsim": 0, "baseline": "none", "error": "numpy missing"}

    with connect() as conn:
        pending = conn.execute(
            "SELECT id, source_ref, embedding_json, embedding_q8 FROM chunks "
            "WHERE build_id = ? AND source_file = ? "
            "AND (dimension = '' OR dimension IS NULL) "
            "AND embedding_json IS NOT NULL",
            (build_id, source_file),
        ).fetchall()
        if not pending:
            return {"inherited": 0, "skipped_lowsim": 0, "baseline": "none"}

        # Preferred: segment-centroid baseline (O(segments) << O(chunks))
        seg_rows = conn.execute(
            "SELECT tag, topic_name, line_start, line_end, centroid_json "
            "FROM tag_segments WHERE source_file = ? "
            "AND tag NOT IN ('', 'others') AND tag IS NOT NULL "
            "AND tag NOT LIKE 'wiki:%' "
            "AND centroid_json != ''",
            (source_file,),
        ).fetchall()

    baseline = "centroid" if seg_rows else "per_chunk"
    cls_vecs: list[list[float]] = []
    cls_meta: list[dict] = []

    if seg_rows:
        for s in seg_rows:
            try:
                v = json.loads(s["centroid_json"])
                if not v:
                    continue
                cls_vecs.append(v)
                cls_meta.append({
                    "dimension": s["tag"],
                    "topic_name": s["topic_name"],
                    "range": f"L{s['line_start']}-{s['line_end']}",
                })
            except (json.JSONDecodeError, TypeError):
                continue

    if not cls_vecs:
        # Fall back to per-chunk baseline
        baseline = "per_chunk"
        with connect() as conn:
            classified = conn.execute(
                "SELECT source_ref, dimension, embedding_json FROM chunks "
                "WHERE source_file = ? "
                "AND dimension NOT IN ('', 'others') AND dimension IS NOT NULL "
                "AND dimension NOT LIKE 'wiki:%' "
                "AND embedding_json IS NOT NULL",
                (source_file,),
            ).fetchall()
        for r in classified:
            try:
                v = json.loads(r["embedding_json"])
                if not v:
                    continue
                cls_vecs.append(v)
                cls_meta.append({
                    "dimension": r["dimension"],
                    "topic_name": "",
                    "range": r["source_ref"],
                })
            except (json.JSONDecodeError, TypeError):
                continue

    if not cls_vecs:
        return {"inherited": 0, "skipped_lowsim": 0, "baseline": "none"}

    # B3: quantize classified baseline to int8 for fast matmul. Scales cancel
    # in cosine; normalization is applied on the int8 vectors directly.
    cls_arr_f32 = np.asarray(cls_vecs, dtype=np.float32)
    cls_max_abs = np.maximum(np.abs(cls_arr_f32).max(axis=1, keepdims=True), 1e-9)
    cls_i8 = np.clip(np.round(cls_arr_f32 / cls_max_abs * 127), -128, 127).astype(np.int8)
    cls_i32 = cls_i8.astype(np.int32)
    cls_norms = np.sqrt((cls_i32 * cls_i32).sum(axis=1).astype(np.float64))
    cls_norms[cls_norms < 1e-9] = 1.0

    updates: list[tuple[int, str, int, str, float, str]] = []
    skipped = 0
    for r in pending:
        v_i8 = None
        # Prefer the stored int8 column (B3) — zero-cost unpack.
        q8_blob = r["embedding_q8"] if "embedding_q8" in r.keys() else None
        if q8_blob:
            v_i8 = np.frombuffer(q8_blob, dtype=np.int8)
        else:
            try:
                v_f32 = np.asarray(json.loads(r["embedding_json"]), dtype=np.float32)
            except (json.JSONDecodeError, TypeError):
                continue
            ma = float(np.abs(v_f32).max())
            if ma < 1e-9:
                continue
            v_i8 = np.clip(np.round(v_f32 / ma * 127), -128, 127).astype(np.int8)
        if v_i8.size == 0 or v_i8.size != cls_i8.shape[1]:
            continue
        v_i32 = v_i8.astype(np.int32)
        v_norm = float(np.sqrt((v_i32 * v_i32).sum()))
        if v_norm < 1e-9:
            continue
        # Int8 matmul → int32 dot → cosine via int norms. Scales cancel so
        # we don't even need them.
        dots = (cls_i32 @ v_i32).astype(np.float64)
        sims = dots / (cls_norms * v_norm)
        best = int(np.argmax(sims))
        sim = float(sims[best])
        if sim >= threshold:
            line_no = _parse_line_no(r["source_ref"])
            if line_no is None:
                continue
            meta = cls_meta[best]
            updates.append((
                r["id"], meta["dimension"], line_no, meta["range"], sim,
                meta.get("topic_name", "") or "auto-inherited",
            ))
        else:
            skipped += 1

    if not updates:
        return {"inherited": 0, "skipped_lowsim": skipped, "baseline": baseline}

    with connect() as conn:
        for chunk_id, tag, line_no, src_ref, sim, topic in updates:
            conn.execute("UPDATE chunks SET dimension = ? WHERE id = ?", (tag, chunk_id))
            conn.execute(
                """INSERT INTO tag_segments(build_id, source_file, tag, topic_name,
                   line_start, line_end, summary, keywords_json, entities_json, is_credential)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)""",
                (build_id, source_file, tag, topic,
                 line_no, line_no,
                 f"Auto-inherited from {src_ref} (cos={sim:.2f})",
                 "[]", "[]"),
            )
        conn.commit()

    return {
        "inherited": len(updates),
        "skipped_lowsim": skipped,
        "baseline": baseline,
    }


def merge_adjacent_segments(build_id: str, max_gap: int = 10) -> dict:
    """Merge adjacent tag_segments that share (source_file, tag) and are
    separated by no more than ``max_gap`` lines. The surviving row keeps the
    longer topic_name/summary and the union of keywords.
    """
    with connect() as conn:
        rows = conn.execute(
            "SELECT id, source_file, tag, topic_name, line_start, line_end, "
            "       summary, keywords_json, is_credential "
            "FROM tag_segments WHERE build_id = ? "
            "ORDER BY source_file, tag, line_start, line_end",
            (build_id,),
        ).fetchall()

    if len(rows) < 2:
        return {"merged": 0, "final_count": len(rows)}

    groups: dict[tuple[str, str], list[dict]] = {}
    for r in rows:
        key = (r["source_file"], r["tag"])
        groups.setdefault(key, []).append({
            "id": r["id"],
            "line_start": r["line_start"],
            "line_end": r["line_end"],
            "topic_name": r["topic_name"] or "",
            "summary": r["summary"] or "",
            "keywords_json": r["keywords_json"] or "[]",
            "is_credential": r["is_credential"],
        })

    merged_total = 0
    with connect() as conn:
        for segs in groups.values():
            segs.sort(key=lambda s: (s["line_start"], s["line_end"]))
            i = 0
            while i < len(segs) - 1:
                a = segs[i]
                b = segs[i + 1]
                # Merge when b overlaps or is within max_gap lines of a.
                if b["line_start"] - a["line_end"] <= max_gap:
                    new_start = min(a["line_start"], b["line_start"])
                    new_end = max(a["line_end"], b["line_end"])
                    # Prefer the more informative topic_name/summary — skip
                    # the "auto-inherited" placeholder when a real one exists.
                    def _better(x: str, y: str) -> str:
                        if x and x != "auto-inherited" and y == "auto-inherited":
                            return x
                        if y and y != "auto-inherited" and x == "auto-inherited":
                            return y
                        return x if len(x) >= len(y) else y

                    new_topic = _better(a["topic_name"], b["topic_name"])
                    new_summary = _better(a["summary"], b["summary"])
                    try:
                        kwa = json.loads(a["keywords_json"])
                        kwb = json.loads(b["keywords_json"])
                        new_kw = list(dict.fromkeys([*kwa, *kwb]))[:200]
                    except (json.JSONDecodeError, TypeError):
                        new_kw = []
                    is_cred = a["is_credential"] or b["is_credential"]
                    conn.execute(
                        "UPDATE tag_segments SET line_start = ?, line_end = ?, "
                        "topic_name = ?, summary = ?, keywords_json = ?, is_credential = ? "
                        "WHERE id = ?",
                        (new_start, new_end, new_topic, new_summary,
                         json.dumps(new_kw, ensure_ascii=False),
                         1 if is_cred else 0, a["id"]),
                    )
                    conn.execute("DELETE FROM tag_segments WHERE id = ?", (b["id"],))
                    a["line_start"] = new_start
                    a["line_end"] = new_end
                    a["topic_name"] = new_topic
                    a["summary"] = new_summary
                    a["keywords_json"] = json.dumps(new_kw, ensure_ascii=False)
                    a["is_credential"] = 1 if is_cred else 0
                    segs.pop(i + 1)
                    merged_total += 1
                else:
                    i += 1
        conn.commit()

    return {"merged": merged_total, "final_count": len(rows) - merged_total}
