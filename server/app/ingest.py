from __future__ import annotations

import hashlib
import json
import os
import re
import sys
from pathlib import Path

from app.db import connect
from app.dimensions import detect_topic


def _chunk_hash(content: str) -> str:
    """Short stable content hash used for incremental edit detection."""
    return hashlib.sha256((content or "").encode("utf-8")).hexdigest()[:16]


def _find_build_for_source(raw_file: str) -> str | None:
    """Return the most recent non-wiki build for this source_file, or None.

    Preferred over get_active_build_id() for incremental ingest because the
    globally active build may belong to a different file.
    """
    with connect() as conn:
        r = conn.execute(
            "SELECT id FROM builds "
            "WHERE source_file = ? AND source_file NOT LIKE 'wiki:%' "
            "ORDER BY created_at DESC LIMIT 1",
            (raw_file,),
        ).fetchone()
    return r["id"] if r else None


def _copy_build_data(old_id: str, new_id: str, source_file: str) -> None:
    """Copy chunks and tag_segments from old_id to new_id for source_file.

    This is the copy-on-write step for incremental ingest: the old build is
    preserved as a clean snapshot while the new build inherits all its data
    before incremental changes are applied.
    """
    with connect() as conn:
        conn.execute(
            """
            INSERT INTO chunks
              (build_id, source_file, source_ref, text, text_segmented,
               dimension, project_slug, embedding_json, keywords_json,
               entities_json, ai_summary, content_hash, note_ts)
            SELECT ?, source_file, source_ref, text, text_segmented,
               dimension, project_slug, embedding_json, keywords_json,
               entities_json, ai_summary, content_hash, note_ts
            FROM chunks WHERE build_id = ? AND source_file = ?
            """,
            (new_id, old_id, source_file),
        )
        conn.execute(
            """
            INSERT INTO tag_segments
              (build_id, source_file, tag, topic_name, line_start, line_end,
               summary, keywords_json, entities_json, is_credential, centroid_json)
            SELECT ?, source_file, tag, topic_name, line_start, line_end,
               summary, keywords_json, entities_json, is_credential, centroid_json
            FROM tag_segments WHERE build_id = ? AND source_file = ?
            """,
            (new_id, old_id, source_file),
        )
        conn.commit()


from app.embed import embed_texts
from app.tokenizer import segment
from app.ai_enrich import classify_lines
from app.builds import create_build, finalize_build
from app.versioning import create_snapshot


_step_timers: dict[str, float] = {}


def _progress(step: str, current: int = 0, total: int = 0, detail: str = ""):
    """Emit a progress line to stderr as JSON (Rust reads this in real-time).

    Also publishes to the in-process event bus so SSE subscribers (the Electron
    desktop app, when ingest is triggered via the gateway instead of the CLI)
    can observe the same events.
    """
    import time as _t
    now = _t.time()
    if step not in _step_timers:
        _step_timers[step] = now
    elapsed_ms = int((now - _step_timers[step]) * 1000)
    msg = {
        "step": step,
        "current": current,
        "total": total,
        "detail": detail,
        "elapsed_ms": elapsed_ms,
    }
    print(json.dumps(msg, ensure_ascii=False), file=sys.stderr, flush=True)
    try:
        from app.events import publish
        publish({"channel": "note", **msg})
    except Exception:
        pass


def _safe_filename(topic: str) -> str:
    """Convert a topic string to a safe filename (without .md extension)."""
    safe = re.sub(r"[^\w\u4e00-\u9fff\-]", "-", topic).strip("-").lower()
    safe = re.sub(r"-+", "-", safe)  # collapse multiple dashes
    return safe[:60] or "misc"


def _split_lines(text: str) -> list[str]:
    lines = [ln.strip() for ln in text.splitlines()]
    return [ln for ln in lines if ln]


def _append_markdown(path: Path, title: str, line: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        path.write_text(f"# {title}\n\n", encoding="utf-8")
    with path.open("a", encoding="utf-8") as f:
        f.write(f"- {line}\n")


def _extract_bullet_chunks(lines: list[str]) -> list[tuple[int, str]]:
    chunks: list[tuple[int, str]] = []
    current_start = 0
    buffer: list[str] = []

    for idx, line in enumerate(lines, start=1):
        striped = line.strip()
        if (
            striped.startswith("- ")
            or striped.startswith("* ")
            or striped.startswith("1.")
        ):
            if buffer:
                chunks.append((current_start, "\n".join(buffer).strip()))
            current_start = idx
            buffer = [striped]
            continue

        if striped.startswith("#") and buffer:
            chunks.append((current_start, "\n".join(buffer).strip()))
            buffer = []
            current_start = 0

        if buffer:
            buffer.append(striped)

    if buffer:
        chunks.append((current_start, "\n".join(buffer).strip()))
    return [(s, c) for s, c in chunks if c]


def _extract_line_chunks(lines: list[str]) -> list[tuple[int, str]]:
    chunks: list[tuple[int, str]] = []
    for idx, line in enumerate(lines, start=1):
        striped = line.strip()
        if striped:
            chunks.append((idx, striped))
    return chunks


def _split_long_chunk(chunk: str, max_len: int = 240) -> list[str]:
    if len(chunk) <= max_len:
        return [chunk]
    parts = re.split(r"(?<=[。！？；;.!?])\s+|\n+", chunk)
    acc: list[str] = []
    buf = ""
    for p in parts:
        piece = p.strip()
        if not piece:
            continue
        if not buf:
            buf = piece
            continue
        if len(buf) + 1 + len(piece) <= max_len:
            buf = f"{buf} {piece}"
        else:
            acc.append(buf)
            buf = piece
    if buf:
        acc.append(buf)
    return acc or [chunk]


def _build_entries(text: str) -> list[tuple[int, str, str]]:
    raw_lines = text.splitlines()
    line_chunks = _extract_line_chunks(raw_lines)
    bullet_chunks = _extract_bullet_chunks(raw_lines)

    combined: list[tuple[int, str, str]] = []
    for start, chunk in line_chunks:
        combined.append((start, chunk, "line"))
    for start, chunk in bullet_chunks:
        combined.append((start, chunk, "bullet"))

    combined.sort(key=lambda x: (x[0], 0 if x[2] == "bullet" else 1))
    dedup = {}
    for start, chunk, kind in combined:
        for idx, sub in enumerate(_split_long_chunk(chunk), start=1):
            key = f"{start}:{idx}:{sub}"
            dedup[key] = (start, sub, kind)
    values = list(dedup.values())
    values.sort(key=lambda x: (x[0], 0 if x[2] == "bullet" else 1, x[1]))
    return values


def _store_entities(conn, entities: list[dict]) -> list[int]:
    """Store entities and return their IDs."""
    entity_ids = []
    for ent in entities:
        name = ent.get("name", "").strip()
        etype = ent.get("type", "concept")
        if not name:
            continue
        existing = conn.execute(
            "SELECT id FROM entities WHERE name = ?", (name,)
        ).fetchone()
        if existing:
            conn.execute(
                "UPDATE entities SET mention_count = mention_count + 1, last_seen = CURRENT_TIMESTAMP WHERE id = ?",
                (existing["id"],),
            )
            entity_ids.append(existing["id"])
        else:
            conn.execute(
                "INSERT INTO entities(name, entity_type) VALUES(?, ?)",
                (name, etype),
            )
            eid = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
            entity_ids.append(eid)
    return entity_ids


def _store_entity_links(conn, entity_ids: list[int]) -> None:
    """Create co-occurrence links between all entities in the same chunk."""
    for i, eid_a in enumerate(entity_ids):
        for eid_b in entity_ids[i + 1 :]:
            a, b = min(eid_a, eid_b), max(eid_a, eid_b)
            existing = conn.execute(
                "SELECT id FROM entity_links WHERE source_entity_id = ? AND target_entity_id = ? AND relation = 'co-occurs'",
                (a, b),
            ).fetchone()
            if existing:
                conn.execute(
                    "UPDATE entity_links SET weight = weight + 1 WHERE id = ?",
                    (existing["id"],),
                )
            else:
                conn.execute(
                    "INSERT INTO entity_links(source_entity_id, target_entity_id, relation) VALUES(?, ?, 'co-occurs')",
                    (a, b),
                )


def ingest_raw(
    raw_path: str,
    note_path: str,
    reset: bool = False,
    ai_delegate: bool = False,
    force_no_ai: bool = False,
) -> dict:
    raw_file = Path(raw_path)
    note_file = Path(note_path)
    views_dir = note_file.parent / "views"
    state_file = note_file.parent / ".state.json"

    if not raw_file.exists():
        raise FileNotFoundError(f"raw file not found: {raw_path}")

    _progress("parse", 0, 0, "Reading raw file...")
    text = raw_file.read_text(encoding="utf-8", errors="ignore")

    # C4: enqueue inline image references for OCR (best-effort; skipped
    # silently if tesseract isn't installed). Runs async via /ocr/process.
    try:
        from app.ocr import scan_image_refs, enqueue_pending_ocr
        refs = scan_image_refs(text)
        if refs:
            enqueue_pending_ocr(str(raw_file), refs)
    except Exception:
        pass
    raw_lines = text.splitlines()          # full raw count (including blanks)
    raw_line_count = len(raw_lines)
    lines = _split_lines(text)             # non-empty lines only
    entries = _build_entries(text)         # (raw_line_no_1based, content, kind)

    state = {"last_line": 0}

    # Build ID: incremental reuses the MOST RECENT build for THIS source_file
    # (fix: older code used globally-active build which may belong to another
    # file in multi-note setups).
    from app.builds import get_active_build_id
    if reset:
        # Loud warning if the current active build was enriched by an MCP
        # caller (Claude): reset wipes chunks + tag_segments for this file,
        # so Claude's classifications are about to be lost. Not blocking —
        # if you really mean to rebuild, proceed; the prior build row and
        # any pre-rebuild snapshot remain.
        try:
            from app.db import connect as _conn
            active_id = get_active_build_id()
            if active_id:
                with _conn() as _c:
                    row = _c.execute(
                        "SELECT completed_by, segment_count FROM builds "
                        "WHERE id = ? AND source_file = ?",
                        (active_id, str(raw_file)),
                    ).fetchone()
                if row and (row["completed_by"] or "") == "mcp:delegate":
                    _progress(
                        "parse",
                        0,
                        0,
                        f"WARNING: active build {active_id} has {row['segment_count']} "
                        f"segments classified by MCP delegate (Claude). Reset will "
                        f"wipe them. A pre-rebuild snapshot will be created for recovery.",
                    )
                    sys.stderr.write(
                        f"[ingest_raw] WARNING: resetting will wipe {row['segment_count']} "
                        f"mcp:delegate segments from build {active_id}. Source: {raw_file}\n"
                    )
                    sys.stderr.flush()
        except Exception:
            pass
        build_id = create_build(str(raw_file), kind="full")
        _progress("parse", 0, 0, f"New build {build_id}")
    else:
        old_build_id = _find_build_for_source(str(raw_file))
        build_id = create_build(str(raw_file), kind="incremental")
        if old_build_id:
            _progress("parse", 0, 0, f"Branching {old_build_id} → {build_id}")
            _copy_build_data(old_build_id, build_id, str(raw_file))
        else:
            _progress("parse", 0, 0, f"New build {build_id}")

    if reset:
        _progress("parse", 0, 0, "Creating snapshot before rebuild...")
        try:
            create_snapshot(note_path, reason="pre-rebuild")
        except Exception:
            pass
        _progress("parse", 0, 0, "Clearing existing data...")
        if note_file.exists():
            note_file.unlink()
        if views_dir.exists():
            for p in views_dir.glob("*.md"):
                p.unlink()
        if state_file.exists():
            state_file.unlink()
    elif state_file.exists():
        state = json.loads(state_file.read_text(encoding="utf-8"))

    start_idx = int(state.get("last_line", 0))

    # ── Edit detection (incremental only) ──
    # Per-source_ref content-hash diff between the file on disk and chunks
    # in the DB. Three buckets:
    #   - changed_refs: content hash differs → DELETE old chunks, will be
    #     re-embedded + re-classified via new_entries.
    #   - removed_refs: chunk exists in DB but line is gone from file →
    #     DELETE; emit a warning (tag_segments covering those lines may now
    #     be stale).
    #   - unchanged_refs: content identical → skip entirely, even if the
    #     (off-by-many historical bug of) state.last_line would have flagged
    #     them as "new". This self-heals bad state files without duplicates.
    changed_refs: set[str] = set()
    removed_refs: set[str] = set()
    unchanged_refs: set[str] = set()
    if not reset:
        def _ref(line_no: int, kind: str) -> str:
            return f"{raw_file.name}:line:{line_no}:{kind}"

        current_groups: dict[str, list[str]] = {}
        for line_no, content, kind in entries:
            current_groups.setdefault(_ref(line_no, kind), []).append(_chunk_hash(content))
        for ref in current_groups:
            current_groups[ref].sort()

        with connect() as conn:
            existing_rows = conn.execute(
                "SELECT source_ref, content_hash FROM chunks "
                "WHERE build_id = ? AND source_file = ?",
                (build_id, str(raw_file)),
            ).fetchall()
        existing_groups: dict[str, list[str]] = {}
        for r in existing_rows:
            existing_groups.setdefault(r["source_ref"], []).append(r["content_hash"] or "")
        for ref in existing_groups:
            existing_groups[ref].sort()

        for ref, cur_hashes in current_groups.items():
            old_hashes = existing_groups.get(ref)
            if old_hashes is None:
                continue  # new ref — handled by new_entries filter naturally
            if old_hashes == cur_hashes:
                unchanged_refs.add(ref)
            else:
                changed_refs.add(ref)
        for ref in existing_groups:
            if ref not in current_groups:
                removed_refs.add(ref)

        to_delete = changed_refs | removed_refs
        if to_delete:
            _progress(
                "parse", 0, 0,
                f"Edit detected: {len(changed_refs)} changed, {len(removed_refs)} removed refs",
            )
            with connect() as conn:
                ph = ",".join("?" for _ in to_delete)
                # Capture ids before delete so we can invalidate the answer
                # cache — any cached answer that used these chunks as evidence
                # is now stale (content changed / line removed).
                victim_rows = conn.execute(
                    f"SELECT id FROM chunks WHERE build_id = ? AND source_file = ? "
                    f"AND source_ref IN ({ph})",
                    (build_id, str(raw_file), *to_delete),
                ).fetchall()
                victim_ids = [r["id"] for r in victim_rows]
                conn.execute(
                    f"DELETE FROM chunks WHERE build_id = ? AND source_file = ? "
                    f"AND source_ref IN ({ph})",
                    (build_id, str(raw_file), *to_delete),
                )
                conn.commit()
            if victim_ids:
                try:
                    from app.cache import invalidate_chunks
                    dropped = invalidate_chunks(victim_ids)
                    if dropped:
                        _progress("parse", 0, 0, f"Invalidated {dropped} stale answer-cache entries")
                except Exception:
                    pass

    # new_entries = appended beyond last_line (minus anything still present
    # with matching hash — covers bad state files) UNION ref content changed.
    def _entry_ref(e):
        return f"{raw_file.name}:line:{e[0]}:{e[2]}"

    new_entries = [
        e for e in entries
        if (e[0] > start_idx and _entry_ref(e) not in unchanged_refs)
        or _entry_ref(e) in changed_refs
    ]

    if not note_file.exists():
        note_file.write_text("# note\n\n", encoding="utf-8")

    total = len(new_entries)
    if not new_entries:
        # Still update the watermark so subsequent runs use raw_line_count
        # semantics (including cases where only blank lines were appended).
        try:
            state_file.write_text(
                json.dumps({"last_line": raw_line_count}, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
        except Exception:
            pass
        _progress("done", 0, 0, "No new content.")
        return {
            "inserted": 0,
            "total": len(entries),
            "dimensions": {},
            "total_lines": raw_line_count,
            "non_empty_lines": len(lines),
            "was_incremental": (not reset),
            "new_entries": 0,
            "changed_refs": len(changed_refs),
            "removed_refs": len(removed_refs),
            "build_id": build_id,
            "message": "No new content to ingest.",
        }

    _progress("parse", total, total, f"Found {total} new chunks to process")

    # Step 1: Embed all chunks
    _progress("embed", 0, total, "Generating embeddings...")
    vectors = embed_texts([entry[1] for entry in new_entries])
    _progress("embed", total, total, "Embeddings done")

    # Step 2: Segment all chunks with jieba
    _progress("segment", 0, total, "Segmenting text (jieba)...")
    segmented = []
    for i, entry in enumerate(new_entries):
        segmented.append(segment(entry[1]))
        if (i + 1) % 10 == 0 or i + 1 == total:
            _progress("segment", i + 1, total, f"Segmented {i + 1}/{total}")
    _progress("segment", total, total, "Segmentation done")

    # Step 3: Tag classification (line ranges → tags)
    from app.config import settings as _cfg
    from app.ai_enrich import LINES_PER_BATCH as _LPB, MAX_CONCURRENCY as _MC, reset_token_usage, get_token_usage
    reset_token_usage()
    total_lines = len(lines)
    _ai_features = getattr(_cfg, "ai_features_enabled", True)
    _api_key = bool(getattr(_cfg, "provider_api_key", "") or "")
    # Auto-enable AI enrichment whenever features are on AND an API key is
    # configured. The separate INGEST_AI_ENABLED flag remains an explicit opt-in
    # alternative (e.g. when the key is supplied by another means).
    ai_active = (not ai_delegate) and (not force_no_ai) and _ai_features and (_api_key or _cfg.ingest_ai_enabled)
    if ai_active:
        batches_needed = (total_lines + _LPB - 1) // _LPB
        _progress("ai_enrich", 0, total_lines, f"Tag classification ({batches_needed} batches, {_MC} concurrent)...")
    elif force_no_ai:
        _progress("ai_enrich", 0, total_lines, "Incremental pack apply — skipping AI, non-AI classification only")
    elif ai_delegate:
        _progress("ai_enrich", 0, total_lines, "AI enrichment delegated to caller (MCP) — skipping provider calls")
    elif not _ai_features:
        _progress("ai_enrich", 0, total_lines, "AI features disabled, using fallback...")
    elif not _api_key:
        _progress("ai_enrich", 0, total_lines, "No PROVIDER_API_KEY configured, using fallback...")
    else:
        _progress("ai_enrich", 0, total_lines, "AI disabled, using fallback...")

    import time as _time
    _ai_start = _time.time()

    # Read ALL lines from raw file (not just new entries)
    all_raw_lines = text.splitlines()

    def _ai_progress(done: int, total_count: int) -> None:
        elapsed = _time.time() - _ai_start
        if done > 0:
            rate = elapsed / done
            remaining = int(rate * (total_count - done))
            eta = f"{remaining // 60}m{remaining % 60}s" if remaining >= 60 else f"{remaining}s"
            _progress("ai_enrich", done, total_count, f"{done}/{total_count} lines classified (ETA {eta})")

    if not ai_active and not ai_delegate:
        # Non-AI classification: single "others" segment covering the file. The
        # AI path below would also fall through to this when the provider is
        # unreachable, so force_no_ai just short-circuits the network hop.
        tag_segments = [{
            "tag": "others",
            "line_start": 1,
            "line_end": total_lines,
            "summary": "Unclassified content",
            "keywords": [],
            "entities": [],
            "is_credential": False,
        }] if total_lines else []
    else:
        tag_segments = classify_lines(all_raw_lines, on_progress=_ai_progress, delegate=ai_delegate)

    # Show which tags were found
    found_tags: dict[str, int] = {}
    for seg in tag_segments:
        found_tags[seg["tag"]] = found_tags.get(seg["tag"], 0) + 1
    tag_summary = ", ".join(f"{t}({c})" for t, c in sorted(found_tags.items(), key=lambda x: -x[1]))
    _progress("ai_enrich", total_lines, total_lines, f"{len(tag_segments)} segments: {tag_summary}")

    # Store tag segments
    with connect() as conn:
        if reset:
            conn.execute("DELETE FROM tag_segments WHERE source_file = ?", (str(raw_file),))
            # Note: entities/entity_links are NOT deleted on reset — they're
            # append-only counters. Global deletion would corrupt other files'
            # entity data. Stale entities are harmless; missing ones are not.
        for seg in tag_segments:
            all_tags = [seg["tag"]] + seg.get("secondary_tags", [])
            conn.execute(
                """
                INSERT INTO tag_segments(build_id, source_file, tag, topic_name, line_start, line_end, summary, keywords_json, entities_json, is_credential)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    build_id,
                    str(raw_file),
                    seg["tag"],
                    seg.get("topic_name", ""),
                    seg["line_start"],
                    seg["line_end"],
                    seg.get("summary", ""),
                    json.dumps(seg.get("keywords", []), ensure_ascii=False),
                    json.dumps(seg.get("entities", []), ensure_ascii=False),
                    1 if seg.get("is_credential") else 0,
                ),
            )
            # Also insert rows for secondary tags (so they appear in tag views)
            for stag in seg.get("secondary_tags", []):
                if stag and isinstance(stag, str) and stag != seg["tag"]:
                    try:
                        conn.execute(
                            """
                            INSERT INTO tag_segments(build_id, source_file, tag, line_start, line_end, summary, keywords_json, entities_json, is_credential)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                            """,
                            (build_id, str(raw_file), stag, seg["line_start"], seg["line_end"],
                             seg.get("summary", ""), json.dumps(seg.get("keywords", []), ensure_ascii=False),
                             json.dumps(seg.get("entities", []), ensure_ascii=False),
                             1 if seg.get("is_credential") else 0),
                        )
                    except Exception:
                        pass

            # Store entities linked to this tag (for KG-tag connection)
            for ent in seg.get("entities", []):
                if not isinstance(ent, dict):
                    continue
                name = ent.get("name", "").strip()
                etype = ent.get("type", "concept")
                if not name:
                    continue
                try:
                    existing = conn.execute("SELECT id FROM entities WHERE name = ?", (name,)).fetchone()
                    if existing:
                        conn.execute("UPDATE entities SET mention_count = mention_count + 1, last_seen = CURRENT_TIMESTAMP WHERE id = ?", (existing["id"],))
                    else:
                        conn.execute("INSERT OR IGNORE INTO entities(name, entity_type) VALUES(?, ?)", (name, etype))
                except Exception:
                    pass  # Never fail ingest for entity storage

        conn.commit()

    # Build a tag lookup for chunks (map line_no → primary tag)
    line_to_tag: dict[int, str] = {}
    for seg in tag_segments:
        for ln in range(seg["line_start"], seg["line_end"] + 1):
            line_to_tag[ln] = seg["tag"]

    # Step 4: Store chunks for search
    _progress("store", 0, total, "Storing chunks...")
    inserted = 0
    tag_counts: dict[str, int] = {}
    # In delegate mode, chunks are stored with empty dimension (pending).
    # submit_enrichments → classify will fill these in afterwards.
    default_dim = "" if ai_delegate else "others"
    with connect() as conn:
        if reset:
            conn.execute("DELETE FROM chunks WHERE source_file = ?", (str(raw_file),))
        for idx, (line_no, content, kind) in enumerate(new_entries):
            tag = line_to_tag.get(line_no, default_dim)
            seg_tokens = segmented[idx].split()
            all_keywords = [t for t in seg_tokens if len(t) > 1]

            source_ref = f"{raw_file.name}:line:{line_no}:{kind}"

            # B3: also store int8-quantized form for fast cosine in retrieval.
            from app.quantize import quantize_int8
            q8_bytes, q8_scale = quantize_int8(vectors[idx])
            conn.execute(
                """
                INSERT INTO chunks(build_id, source_file, source_ref, text, text_segmented,
                  dimension, project_slug, embedding_json, keywords_json, entities_json,
                  ai_summary, content_hash, embedding_q8, embedding_scale)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    build_id,
                    str(raw_file),
                    source_ref,
                    content,
                    segmented[idx],
                    tag,
                    None,
                    json.dumps(vectors[idx]),
                    json.dumps(all_keywords, ensure_ascii=False),
                    "[]",
                    "",
                    _chunk_hash(content),
                    q8_bytes,
                    q8_scale,
                ),
            )
            inserted += 1
            tag_counts[tag] = tag_counts.get(tag, 0) + 1

            if (idx + 1) % 20 == 0 or idx + 1 == total:
                _progress("store", idx + 1, total, f"Stored {idx + 1}/{total}")

        conn.commit()

    _progress("views", total, total, "Done")

    # State tracks the raw-file line-count watermark that matches entry[0]
    # semantics. Using len(lines) (non-empty count) was an off-by-many bug
    # that caused incremental runs to re-ingest every line whose raw line_no
    # exceeded the non-empty count.
    state_file.write_text(
        json.dumps({"last_line": raw_line_count}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    # Token usage & cost estimate
    usage = get_token_usage()
    total_tokens = usage.get("total_tokens", 0)
    # Cost estimate: rough average across common models (~$0.5/1M input, ~$1.5/1M output)
    prompt_cost = usage.get("prompt_tokens", 0) * 0.5 / 1_000_000
    completion_cost = usage.get("completion_tokens", 0) * 1.5 / 1_000_000
    total_cost = prompt_cost + completion_cost

    # Auto-classify pipeline (delegate-mode only). Cheapest-first:
    #   hash → centroid cosine → merge → refresh centroids for next round.
    auto_stats: dict = {}
    if ai_delegate and inserted > 0:
        try:
            from app.autoclassify import (
                auto_inherit_by_hash,
                auto_inherit_chunks,
                merge_adjacent_segments,
                refresh_segment_centroids,
            )
            # 1. Exact hash match — zero compute, handles copy-paste repeats
            hash_stats = auto_inherit_by_hash(build_id, str(raw_file))
            auto_stats["hash_inherited"] = hash_stats.get("inherited", 0)

            # 2. Centroid cosine — matches against segment means (50x fewer
            #    comparisons vs per-chunk, and more semantic)
            cos_stats = auto_inherit_chunks(build_id, str(raw_file))
            auto_stats["cosine_inherited"] = cos_stats.get("inherited", 0)
            auto_stats["skipped_lowsim"] = cos_stats.get("skipped_lowsim", 0)
            auto_stats["baseline"] = cos_stats.get("baseline", "none")

            total_inh = auto_stats["hash_inherited"] + auto_stats["cosine_inherited"]
            if total_inh > 0:
                merge_stats = merge_adjacent_segments(build_id)
                auto_stats["merged"] = merge_stats.get("merged", 0)
                _progress("ai_enrich", 0, 0,
                          f"auto: {auto_stats['hash_inherited']} by hash + "
                          f"{auto_stats['cosine_inherited']} by cosine "
                          f"({auto_stats['baseline']}); "
                          f"merged {auto_stats['merged']} segs")

            # 3. Refresh centroids so the NEXT incremental benefits from the
            #    newly classified chunks.
            refresh_segment_centroids(build_id)
        except Exception as e:
            _progress("ai_enrich", 0, 0, f"auto-classify skipped: {e}")

    # Finalize build — mark as active, store metadata. In delegate mode the
    # build is parked in 'awaiting_enrich' until Claude submits classifications
    # (unless auto_inherit cleared everything).
    if ai_delegate:
        completed_by = ""  # filled in by recompute_enrich_status → 'mcp:delegate'
    elif ai_active:
        model = getattr(_cfg, "ingest_ai_model", "") or getattr(_cfg, "provider_chat_model", "")
        completed_by = f"provider:{model}" if model else "provider:unknown"
    else:
        completed_by = "fallback"

    # Recompute pending state AFTER auto_inherit so the final enrich_status
    # reflects whether any chunks remain unclassified.
    final_enrich_status = "awaiting_enrich" if ai_delegate else "completed"
    if ai_delegate:
        with connect() as conn:
            remaining = conn.execute(
                "SELECT COUNT(1) c FROM chunks WHERE build_id = ? "
                "AND (dimension = '' OR dimension IS NULL)",
                (build_id,),
            ).fetchone()
            if int(remaining["c"] or 0) == 0:
                final_enrich_status = "completed"
                total_auto = int(auto_stats.get("hash_inherited", 0) or 0) + int(auto_stats.get("cosine_inherited", 0) or 0)
                completed_by = "mcp:auto_inherit" if total_auto > 0 else ""

    # Sync segment_count from tag_segments (auto_inherit adds rows; merge removes).
    with connect() as conn:
        seg_count_row = conn.execute(
            "SELECT COUNT(1) c FROM tag_segments WHERE build_id = ?", (build_id,)
        ).fetchone()
        segment_count = int(seg_count_row["c"] or 0)

    finalize_build(
        build_id,
        chunk_count=inserted,
        segment_count=segment_count,
        tags=tag_counts,
        token_usage=usage,
        cost_cny=round(total_cost * 7.2, 2),
        enrich_status=final_enrich_status,
        completed_by=completed_by,
    )

    # Build human-readable summary
    tag_list = sorted(tag_counts.items(), key=lambda x: -x[1])
    parts = [f"{count} {tag}" for tag, count in tag_list]
    token_info = ""
    if total_tokens > 0:
        token_info = f" | {total_tokens:,} tokens (~¥{total_cost * 7.2:.2f})"
    summary = f"Ingested {inserted} chunks, {len(tag_segments)} segments, {len(tag_counts)} tags ({', '.join(parts)}){token_info}"

    # Save a post-build version snapshot with cost info
    try:
        create_snapshot(note_path, reason="post-build", extra_meta={
            "token_usage": usage,
            "estimated_cost_usd": round(total_cost, 4),
            "estimated_cost_cny": round(total_cost * 7.2, 2),
            "segments": len(tag_segments),
            "tags": dict(tag_counts),
        })
    except Exception:
        pass

    _progress("done", inserted, total, summary)

    warnings: list[str] = []
    if not reset and removed_refs:
        # Mid-file line removals are detected and their chunks are deleted,
        # but any tag_segments that referenced those line ranges remain and
        # may now point at stale content. A reset is the cleanest fix.
        warnings.append(
            f"{len(removed_refs)} source_refs disappeared from the file. "
            "Tag segments covering those ranges may be stale — consider reset=True."
        )
    return {
        "inserted": inserted,
        "total": len(entries),
        "tags": dict(tag_counts),
        "segments": len(tag_segments),
        "token_usage": usage,
        "estimated_cost_usd": round(total_cost, 4),
        "message": summary,
        "build_id": build_id,
        "source_file": str(raw_file),
        "total_lines": raw_line_count,
        "non_empty_lines": len(lines),
        "was_incremental": (not reset),
        "new_entries": len(new_entries),
        "changed_refs": len(changed_refs),
        "removed_refs": len(removed_refs),
        "enrich_status": final_enrich_status,
        "auto_inherit": auto_stats,
        "warnings": warnings,
    }
