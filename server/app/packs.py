"""Accumulated ingest packs.

Each save of a note (in-app or MCP) and each external edit (detected on load
via md5 mismatch) creates one pending pack. Packs represent "work that
should re-ingest eventually" without forcing the user to run ingest on every
save. The UI surfaces a badge with the pending count.

Apply semantics: applying a pack triggers a normal incremental ingest of the
raw file (reuses existing content_hash logic — packs don't implement their
own "only-changed-lines ingest" path). The pack is just an accounting layer.
"""

from __future__ import annotations

import difflib
import hashlib
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app.db import connect


MAX_DIFF_BYTES = 200_000  # truncate giant diffs to keep DB row sizes sane


# ── Per-line metadata (ts, bookmark, highlight) ──────────────────

def _line_hash(line: str) -> str:
    """Stable 16-hex digest of a trimmed line. Used as the cross-save
    identity for a line of text, so marks survive line-number shifts."""
    return hashlib.sha256(line.strip().encode("utf-8")).hexdigest()[:16]


def stamp_new_lines_on_save(
    file_path: str, before_content: str, after_content: str
) -> int:
    """After a save, insert note_lines rows for lines whose hash didn't exist
    before this save (i.e. genuinely new content). For lines that already
    existed — even if they moved to a new line number — update only
    `line_no_last` / `line_preview`, keep `ts` untouched.

    Returns number of rows inserted (not updated)."""
    ts_now = _now_iso()
    before_hashes = {_line_hash(ln) for ln in before_content.splitlines() if ln}
    after_lines = after_content.splitlines()

    seen: set[str] = set()
    inserts = []
    updates = []
    for idx, ln in enumerate(after_lines, start=1):
        if not ln.strip():
            continue  # skip blank lines — no identity
        h = _line_hash(ln)
        if h in seen:
            continue
        seen.add(h)
        preview = ln[:120]
        if h in before_hashes:
            updates.append((idx, preview, file_path, h))
        else:
            inserts.append((file_path, h, idx, preview, ts_now))

    with connect() as conn:
        # Skip rows that already exist in DB (they may not be in before_hashes
        # if the user opened the file fresh — those rows were created under a
        # prior session; preserve their ts rather than re-inserting).
        existing_in_db = set()
        if inserts:
            rows = conn.execute(
                f"SELECT line_hash FROM note_lines WHERE file_path = ? "
                f"AND line_hash IN ({','.join('?' * len(inserts))})",
                (file_path, *[i[1] for i in inserts]),
            ).fetchall()
            existing_in_db = {r["line_hash"] for r in rows}

        inserted = 0
        for file_path_, h, idx, preview, ts in inserts:
            if h in existing_in_db:
                conn.execute(
                    "UPDATE note_lines SET line_no_last = ?, line_preview = ?, "
                    "updated_at = ? WHERE file_path = ? AND line_hash = ?",
                    (idx, preview, ts, file_path_, h),
                )
                continue
            conn.execute(
                "INSERT INTO note_lines(file_path, line_hash, line_no_last, "
                "line_preview, ts, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
                (file_path_, h, idx, preview, ts, ts),
            )
            inserted += 1

        for idx, preview, file_path_, h in updates:
            conn.execute(
                "UPDATE note_lines SET line_no_last = ?, line_preview = ?, "
                "updated_at = ? WHERE file_path = ? AND line_hash = ?",
                (idx, preview, ts_now, file_path_, h),
            )
        conn.commit()
    return inserted


def refresh_line_positions(file_path: str, content: str) -> int:
    """Called on load. Re-map line_no_last for rows whose hash appears in
    `content`. Does NOT create new rows and does NOT stamp ts — we only know
    when we *observed* a line being written, and a fresh load is not such an
    observation. Returns count of rows updated."""
    hash_to_line_no: dict[str, int] = {}
    for idx, ln in enumerate(content.splitlines(), start=1):
        if not ln.strip():
            continue
        h = _line_hash(ln)
        if h not in hash_to_line_no:
            hash_to_line_no[h] = idx

    if not hash_to_line_no:
        return 0

    now = _now_iso()
    updated = 0
    with connect() as conn:
        for h, line_no in hash_to_line_no.items():
            cur = conn.execute(
                "UPDATE note_lines SET line_no_last = ?, updated_at = ? "
                "WHERE file_path = ? AND line_hash = ? "
                "AND line_no_last != ?",
                (line_no, now, file_path, h, line_no),
            )
            if cur.rowcount > 0:
                updated += cur.rowcount
        conn.commit()
    return updated


def list_line_meta(file_path: str) -> list[dict]:
    """Return per-line metadata for a file, ordered by current line number.
    The UI uses this to render ts in the gutter + show bookmarks/highlights."""
    with connect() as conn:
        rows = conn.execute(
            "SELECT line_no_last, line_hash, ts, bookmark, highlight_color, "
            "highlight_note, line_preview, updated_at "
            "FROM note_lines WHERE file_path = ? "
            "ORDER BY line_no_last ASC",
            (file_path,),
        ).fetchall()
    return [dict(r) for r in rows]


def set_line_mark(
    file_path: str,
    line_hash: str,
    bookmark: str | None = None,
    highlight_color: str | None = None,
    highlight_note: str | None = None,
    line_preview: str | None = None,
    line_no: int | None = None,
) -> dict:
    """Upsert bookmark / highlight on a line. If the row doesn't yet exist
    (i.e. the file has never been saved through /note/save), we create it
    with `ts = NULL` — we don't know when the line was written, and
    fabricating a ts would be dishonest. `line_preview` and `line_no` are
    the caller's best-effort description of the line for list rendering.

    Pass an empty string to clear a specific mark (e.g. bookmark='')."""
    now = _now_iso()
    with connect() as conn:
        row = conn.execute(
            "SELECT * FROM note_lines WHERE file_path = ? AND line_hash = ?",
            (file_path, line_hash),
        ).fetchone()

        if not row:
            # Upsert path: insert a new row with whatever marks the caller
            # wants to apply. ts stays NULL — caller didn't observe the write.
            conn.execute(
                "INSERT INTO note_lines(file_path, line_hash, line_no_last, "
                "line_preview, ts, bookmark, highlight_color, highlight_note, "
                "updated_at) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?)",
                (
                    file_path, line_hash,
                    int(line_no or 0),
                    (line_preview or "")[:120],
                    bookmark or "",
                    highlight_color or "",
                    highlight_note or "",
                    now,
                ),
            )
        else:
            sets, args = [], []
            if bookmark is not None:
                sets.append("bookmark = ?"); args.append(bookmark)
            if highlight_color is not None:
                sets.append("highlight_color = ?"); args.append(highlight_color)
            if highlight_note is not None:
                sets.append("highlight_note = ?"); args.append(highlight_note)
            # Refresh positional hints if the caller provided better ones.
            if line_preview is not None:
                sets.append("line_preview = ?"); args.append(line_preview[:120])
            if line_no is not None and line_no > 0:
                sets.append("line_no_last = ?"); args.append(int(line_no))
            if not sets:
                return dict(row)
            sets.append("updated_at = ?"); args.append(now)
            args.extend([file_path, line_hash])
            conn.execute(
                f"UPDATE note_lines SET {', '.join(sets)} "
                f"WHERE file_path = ? AND line_hash = ?",
                args,
            )
        conn.commit()
        row = conn.execute(
            "SELECT * FROM note_lines WHERE file_path = ? AND line_hash = ?",
            (file_path, line_hash),
        ).fetchone()
    return dict(row)


# ── File state (md5 baseline) ─────────────────────────────────────

def get_file_state(file_path: str) -> dict | None:
    with connect() as conn:
        row = conn.execute(
            "SELECT * FROM note_file_state WHERE file_path = ?",
            (file_path,),
        ).fetchone()
    return dict(row) if row else None


def update_file_state(
    file_path: str,
    content: str,
    mtime: float | None = None,
    last_build_id: str | None = None,
) -> dict:
    md5 = hashlib.md5(content.encode("utf-8")).hexdigest()
    line_count = content.count("\n") + (0 if content.endswith("\n") or not content else 1)
    byte_size = len(content.encode("utf-8"))
    now = _now_iso()
    if mtime is None and os.path.exists(file_path):
        try:
            mtime = os.path.getmtime(file_path)
        except OSError:
            mtime = None

    with connect() as conn:
        existing = conn.execute(
            "SELECT file_path FROM note_file_state WHERE file_path = ?",
            (file_path,),
        ).fetchone()
        if existing:
            conn.execute(
                "UPDATE note_file_state SET md5 = ?, mtime = ?, "
                "line_count = ?, byte_size = ?, "
                "last_build_id = COALESCE(?, last_build_id), updated_at = ? "
                "WHERE file_path = ?",
                (md5, mtime, line_count, byte_size, last_build_id, now, file_path),
            )
        else:
            conn.execute(
                "INSERT INTO note_file_state(file_path, md5, mtime, "
                "line_count, byte_size, last_build_id, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (file_path, md5, mtime, line_count, byte_size, last_build_id, now),
            )
        conn.commit()
    return {"file_path": file_path, "md5": md5, "mtime": mtime, "line_count": line_count, "byte_size": byte_size}


# ── Pack creation ─────────────────────────────────────────────────

def _compute_structured_changes(before_lines: list[str], after_lines: list[str]) -> list[dict]:
    """Extract per-change records from a line-level diff. Each record is
    anchored to the NEW (after) file's line numbering so the UI can jump to
    it in the currently-visible editor buffer.

    op:         'insert' | 'delete' | 'replace'
    line:       primary jump target (1-based line number in after file)
    range:      [start, end] inclusive in after file; equal to [line, line] for
                single-line edits; for 'delete' the range is empty ([line, line-1])
                and the UI should render a caret marker at `line`
    chars_added / chars_removed: byte counts (utf-8)
    chars:      signed delta
    preview:    first 80 chars of the representative line
    """
    sm = difflib.SequenceMatcher(a=before_lines, b=after_lines, autojunk=False)
    out = []
    after_count = len(after_lines)
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "equal":
            continue
        before_chars = sum(len(before_lines[i].encode("utf-8")) for i in range(i1, i2))
        after_chars = sum(len(after_lines[j].encode("utf-8")) for j in range(j1, j2))

        # Jump anchor: position in the NEW file. For pure deletes (j1 == j2),
        # we anchor at j1+1 (the line where content would have been, or
        # equivalently, right after what precedes the delete). Clamp to 1..N.
        if j2 > j1:
            line = j1 + 1
            range_start = j1 + 1
            range_end = j2
            preview = after_lines[j1][:80]
        else:
            line = max(1, min(after_count, j1 + 1 if after_count else 1))
            range_start = line
            range_end = line - 1  # empty range ⇒ delete marker at `line`
            preview = before_lines[i1][:80] if i2 > i1 else ""

        out.append({
            "op": tag,
            "line": line,
            "range": [range_start, range_end],
            "chars_added": after_chars,
            "chars_removed": before_chars,
            "chars": after_chars - before_chars,
            "preview": preview,
        })
    return out


def create_pack(
    raw_path: str,
    before_content: str | None,
    after_content: str,
    kind: str = "in_app",
    note: str = "",
) -> dict:
    """Compute diff + create a pack row. Returns the pack."""
    kind = kind if kind in ("in_app", "external") else "in_app"
    before_content = before_content if before_content is not None else ""
    before_lines = before_content.splitlines(keepends=False)
    after_lines = after_content.splitlines(keepends=False)

    diff_iter = difflib.unified_diff(
        before_lines, after_lines,
        fromfile="before", tofile="after", lineterm=""
    )
    diff_lines = list(diff_iter)
    diff_text = "\n".join(diff_lines)
    if len(diff_text.encode("utf-8")) > MAX_DIFF_BYTES:
        diff_text = diff_text[:MAX_DIFF_BYTES] + "\n... (truncated)"

    changes = _compute_structured_changes(before_lines, after_lines)
    changes_json = json.dumps(changes, ensure_ascii=False)

    added = sum(1 for l in diff_lines if l.startswith("+") and not l.startswith("+++"))
    removed = sum(1 for l in diff_lines if l.startswith("-") and not l.startswith("---"))
    before_md5 = hashlib.md5((before_content or "").encode("utf-8")).hexdigest()
    after_md5 = hashlib.md5(after_content.encode("utf-8")).hexdigest()
    byte_delta = len(after_content.encode("utf-8")) - len((before_content or "").encode("utf-8"))

    # No-op guard: if md5 identical, don't create a pack.
    if before_md5 == after_md5:
        return {"skipped": "no_change", "md5": after_md5}

    with connect() as conn:
        cur = conn.execute(
            "INSERT INTO ingest_packs(raw_path, kind, diff_patch, "
            "before_md5, after_md5, lines_added, lines_removed, byte_delta, "
            "note, status, changes_json, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)",
            (raw_path, kind, diff_text, before_md5, after_md5, added, removed,
             byte_delta, note, changes_json, _now_iso()),
        )
        conn.commit()
        pack_id = cur.lastrowid
    return get_pack(pack_id)


def on_save(raw_path: str, new_content: str, note: str = "") -> dict:
    """Write file + create pack + update file_state + stamp new-line ts.
    Only lines whose hash didn't exist before the save get a ts — we never
    falsify timestamps for content we didn't observe being written."""
    p = Path(raw_path)
    p.parent.mkdir(parents=True, exist_ok=True)
    before_content = p.read_text(encoding="utf-8") if p.exists() else ""
    p.write_text(new_content, encoding="utf-8")
    pack = create_pack(raw_path, before_content, new_content, kind="in_app", note=note)
    state = update_file_state(raw_path, new_content)
    stamped = stamp_new_lines_on_save(raw_path, before_content, new_content)
    return {"pack": pack, "file_state": state, "lines_stamped": stamped}


def on_load(raw_path: str) -> dict:
    """Check on-disk md5 vs stored baseline. If mismatched, create an
    external pack. Returns {content, file_state, external_pack_created}."""
    p = Path(raw_path)
    if not p.exists():
        return {
            "exists": False,
            "content": "",
            "file_state": None,
            "external_pack_created": False,
        }

    content = p.read_text(encoding="utf-8")
    current_md5 = hashlib.md5(content.encode("utf-8")).hexdigest()
    prior = get_file_state(raw_path)

    external_pack = None
    if prior and prior.get("md5") and prior["md5"] != current_md5:
        # Reconstruct "before" by re-reading stored md5 is impossible without
        # the old content. Instead, mark the pack with a diff between an
        # empty-ish baseline (we lost the old content) and new content. The
        # pack still records the event — user can apply to re-ingest.
        external_pack = create_pack(
            raw_path=raw_path,
            before_content=None,
            after_content=content,
            kind="external",
            note=f"md5 changed {prior['md5'][:8]} → {current_md5[:8]}",
        )

    state = update_file_state(raw_path, content)
    # Do NOT stamp ts on load — we don't actually know when existing lines
    # were written. Just re-align `line_no_last` for rows whose hash still
    # appears in the file, so the right-side ts widget lines up correctly.
    refresh_line_positions(raw_path, content)
    return {
        "exists": True,
        "content": content,
        "file_state": state,
        "external_pack_created": external_pack is not None,
        "external_pack": external_pack,
    }


# ── Pack lifecycle ────────────────────────────────────────────────

def _hydrate_pack(row) -> dict:
    d = dict(row)
    raw = d.pop("changes_json", "[]") or "[]"
    try:
        d["changes"] = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        d["changes"] = []
    return d


def list_packs(
    raw_path: str | None = None,
    status: str = "pending",
    limit: int = 50,
) -> list[dict]:
    q = "SELECT * FROM ingest_packs WHERE 1=1"
    args: list[Any] = []
    if raw_path:
        q += " AND raw_path = ?"
        args.append(raw_path)
    if status and status != "all":
        q += " AND status = ?"
        args.append(status)
    q += " ORDER BY created_at DESC LIMIT ?"
    args.append(limit)

    with connect() as conn:
        rows = conn.execute(q, args).fetchall()
    return [_hydrate_pack(r) for r in rows]


def get_pack(pack_id: int) -> dict:
    with connect() as conn:
        row = conn.execute(
            "SELECT * FROM ingest_packs WHERE id = ?", (pack_id,)
        ).fetchone()
    if not row:
        raise KeyError(f"pack not found: {pack_id}")
    return _hydrate_pack(row)


def pending_count(raw_path: str | None = None) -> int:
    q = "SELECT COUNT(*) AS c FROM ingest_packs WHERE status = 'pending'"
    args: list[Any] = []
    if raw_path:
        q += " AND raw_path = ?"
        args.append(raw_path)
    with connect() as conn:
        row = conn.execute(q, args).fetchone()
    return int(row["c"] if row else 0)


def discard_pack(pack_id: int) -> dict:
    pack = get_pack(pack_id)
    if pack["status"] != "pending":
        return pack
    with connect() as conn:
        conn.execute(
            "UPDATE ingest_packs SET status = 'discarded' WHERE id = ?",
            (pack_id,),
        )
        conn.commit()
    return get_pack(pack_id)


def apply_pack(pack_id: int, build_id: str | None = None) -> dict:
    """Mark pack as applied under the given build. Does NOT trigger the
    actual ingest — caller (gateway) runs ingest_raw and passes the resulting
    build_id in. Pack acts as accounting only."""
    pack = get_pack(pack_id)
    if pack["status"] != "pending":
        return pack
    with connect() as conn:
        conn.execute(
            "UPDATE ingest_packs SET status = 'applied', "
            "applied_build_id = ?, applied_at = ? WHERE id = ?",
            (build_id, _now_iso(), pack_id),
        )
        conn.commit()
    return get_pack(pack_id)


def apply_all_for_path(raw_path: str, build_id: str | None = None) -> int:
    """Mark every pending pack for `raw_path` as applied under `build_id`.
    Returns the count marked. Use after running a single ingest that covers
    all the pending changes."""
    now = _now_iso()
    with connect() as conn:
        cur = conn.execute(
            "UPDATE ingest_packs SET status = 'applied', "
            "applied_build_id = ?, applied_at = ? "
            "WHERE raw_path = ? AND status = 'pending'",
            (build_id, now, raw_path),
        )
        conn.commit()
        return cur.rowcount


def merge_packs(pack_ids: list[int]) -> dict:
    """Collapse several pending packs into one. The newest becomes the
    survivor; the rest are marked merged_into=survivor_id with status='merged'.
    The survivor's line counts and byte_delta are summed; its diff keeps the
    newest (we don't try to concatenate unified diffs sensibly)."""
    if not pack_ids or len(pack_ids) < 2:
        raise ValueError("merge needs at least 2 pack ids")
    ids = sorted(set(pack_ids))
    with connect() as conn:
        rows = conn.execute(
            f"SELECT * FROM ingest_packs WHERE id IN ({','.join('?' * len(ids))}) "
            "AND status = 'pending' ORDER BY created_at DESC",
            ids,
        ).fetchall()
        if len(rows) < 2:
            raise ValueError("not enough pending packs to merge")

        survivor = dict(rows[0])
        merged_in = [dict(r) for r in rows[1:]]

        total_added = survivor["lines_added"] + sum(r["lines_added"] for r in merged_in)
        total_removed = survivor["lines_removed"] + sum(r["lines_removed"] for r in merged_in)
        total_bytes = survivor["byte_delta"] + sum(r["byte_delta"] for r in merged_in)

        conn.execute(
            "UPDATE ingest_packs SET lines_added = ?, lines_removed = ?, "
            "byte_delta = ?, note = note || ? WHERE id = ?",
            (total_added, total_removed, total_bytes,
             f" · merged {len(merged_in)} older pack(s)", survivor["id"]),
        )
        for r in merged_in:
            conn.execute(
                "UPDATE ingest_packs SET status = 'merged', merged_into = ? "
                "WHERE id = ?",
                (survivor["id"], r["id"]),
            )
        conn.commit()
    return get_pack(survivor["id"])


# ── internals ─────────────────────────────────────────────────────

def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
