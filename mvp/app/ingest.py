from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

from app.db import connect
from app.dimensions import detect_topic
from app.embed import embed_texts
from app.tokenizer import segment
from app.ai_enrich import classify_lines
from app.builds import create_build, finalize_build
from app.versioning import create_snapshot


_step_timers: dict[str, float] = {}


def _progress(step: str, current: int = 0, total: int = 0, detail: str = ""):
    """Emit a progress line to stderr as JSON (Rust reads this in real-time)."""
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


def ingest_raw(raw_path: str, note_path: str, reset: bool = False) -> dict:
    raw_file = Path(raw_path)
    note_file = Path(note_path)
    views_dir = note_file.parent / "views"
    state_file = note_file.parent / ".state.json"

    if not raw_file.exists():
        raise FileNotFoundError(f"raw file not found: {raw_path}")

    _progress("parse", 0, 0, "Reading raw file...")
    text = raw_file.read_text(encoding="utf-8", errors="ignore")
    lines = _split_lines(text)
    entries = _build_entries(text)

    state = {"last_line": 0}

    # Build ID: incremental reuses active build, rebuild creates new
    from app.builds import get_active_build_id
    if reset:
        build_id = create_build(str(raw_file))
        _progress("parse", 0, 0, f"New build {build_id}")
    else:
        build_id = get_active_build_id() or create_build(str(raw_file))
        _progress("parse", 0, 0, f"Appending to build {build_id}")

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
    new_entries = [entry for entry in entries if entry[0] > start_idx]

    if not note_file.exists():
        note_file.write_text("# note\n\n", encoding="utf-8")

    total = len(new_entries)
    if not new_entries:
        _progress("done", 0, 0, "No new content.")
        return {
            "inserted": 0,
            "total": len(entries),
            "dimensions": {},
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
    if _cfg.ingest_ai_enabled:
        batches_needed = (total_lines + _LPB - 1) // _LPB
        _progress("ai_enrich", 0, total_lines, f"Tag classification ({batches_needed} batches, {_MC} concurrent)...")
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

    tag_segments = classify_lines(all_raw_lines, on_progress=_ai_progress)

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
            conn.execute("DELETE FROM entities")
            conn.execute("DELETE FROM entity_links")
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
    with connect() as conn:
        if reset:
            conn.execute("DELETE FROM chunks WHERE source_file = ?", (str(raw_file),))
        for idx, (line_no, content, kind) in enumerate(new_entries):
            tag = line_to_tag.get(line_no, "others")
            seg_tokens = segmented[idx].split()
            all_keywords = [t for t in seg_tokens if len(t) > 1]

            source_ref = f"{raw_file.name}:line:{line_no}:{kind}"

            conn.execute(
                """
                INSERT INTO chunks(source_file, source_ref, text, text_segmented,
                  dimension, project_slug, embedding_json, keywords_json, entities_json, ai_summary)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
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
                ),
            )
            inserted += 1
            tag_counts[tag] = tag_counts.get(tag, 0) + 1

            if (idx + 1) % 20 == 0 or idx + 1 == total:
                _progress("store", idx + 1, total, f"Stored {idx + 1}/{total}")

        conn.commit()

    _progress("views", total, total, "Done")

    state_file.write_text(
        json.dumps({"last_line": len(lines)}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    # Token usage & cost estimate
    usage = get_token_usage()
    total_tokens = usage.get("total_tokens", 0)
    # Cost estimate: rough average across common models (~$0.5/1M input, ~$1.5/1M output)
    prompt_cost = usage.get("prompt_tokens", 0) * 0.5 / 1_000_000
    completion_cost = usage.get("completion_tokens", 0) * 1.5 / 1_000_000
    total_cost = prompt_cost + completion_cost

    # Finalize build — mark as active, store metadata
    finalize_build(
        build_id,
        chunk_count=inserted,
        segment_count=len(tag_segments),
        tags=tag_counts,
        token_usage=usage,
        cost_cny=round(total_cost * 7.2, 2),
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

    return {
        "inserted": inserted,
        "total": len(entries),
        "tags": dict(tag_counts),
        "segments": len(tag_segments),
        "token_usage": usage,
        "estimated_cost_usd": round(total_cost, 4),
        "message": summary,
    }
