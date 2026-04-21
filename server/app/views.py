"""Note views — topical lenses over a single raw file.

A view defines a named subset of lines (by `line_hash`) sharing a topic. The
source file is unchanged; views are purely a presentation layer that the
NotePage UI uses to tab between lenses. Membership is stored in
`note_view_member` keyed by `line_hash`, so entries survive line-number
shifts when the user edits the file.

Populate modes (all optional, combinable):
  - keywords: case-insensitive substring match, any of the listed terms.
  - regex:    Python regex applied per line.
  - ai_query: semantic match via retrieval.search, filtered to the view's
              raw_path. Each hit's text is split into lines, non-empty lines
              are hashed and added with source='ai'.

Manual edits always win: `source='manual'` members stay, `excluded=1` rows
keep rule/ai hits out of the view after a re-populate.
"""

from __future__ import annotations

import hashlib
import json
import re
from typing import Iterable

from app.db import connect


# ── helpers ──────────────────────────────────────────────────────

def _line_hash(line: str) -> str:
    """Matches packs._line_hash — kept in sync so bookmarks and view members
    share identity for the same line of text."""
    return hashlib.sha256(line.strip().encode("utf-8")).hexdigest()[:16]


def _now_iso() -> str:
    from datetime import datetime
    return datetime.utcnow().isoformat(timespec="seconds")


def _read_file_lines(raw_path: str) -> list[str]:
    try:
        with open(raw_path, "r", encoding="utf-8", errors="replace") as f:
            return f.read().split("\n")
    except OSError:
        return []


def _parse_json(raw: str, default):
    if not raw:
        return default
    try:
        return json.loads(raw)
    except Exception:
        return default


def _view_row_to_dict(row) -> dict:
    d = dict(row)
    d["rule"] = _parse_json(d.pop("rule_json", "{}"), {})
    d["display"] = _parse_json(d.pop("display_json", "{}"), {})
    return d


# ── CRUD ─────────────────────────────────────────────────────────

def list_views(raw_path: str) -> list[dict]:
    with connect() as conn:
        rows = conn.execute(
            "SELECT id, raw_path, name, rule_json, display_json, sort_order, "
            "created_at, updated_at FROM note_view "
            "WHERE raw_path = ? ORDER BY sort_order ASC, id ASC",
            (raw_path,),
        ).fetchall()
    views = [_view_row_to_dict(r) for r in rows]
    # Attach member counts in a second pass — cheap enough for the small N
    # of views per file.
    if views:
        with connect() as conn:
            for v in views:
                v["member_count"] = conn.execute(
                    "SELECT COUNT(*) FROM note_view_member "
                    "WHERE view_id = ? AND excluded = 0",
                    (v["id"],),
                ).fetchone()[0]
    return views


def get_view(view_id: int) -> dict | None:
    with connect() as conn:
        row = conn.execute(
            "SELECT id, raw_path, name, rule_json, display_json, sort_order, "
            "created_at, updated_at FROM note_view WHERE id = ?",
            (view_id,),
        ).fetchone()
    return _view_row_to_dict(row) if row else None


def create_view(
    raw_path: str,
    name: str,
    rule: dict | None = None,
    display: dict | None = None,
) -> dict:
    now = _now_iso()
    with connect() as conn:
        # Put the new view at the end of the user's tab strip.
        max_sort = conn.execute(
            "SELECT COALESCE(MAX(sort_order), 0) FROM note_view WHERE raw_path = ?",
            (raw_path,),
        ).fetchone()[0]
        cur = conn.execute(
            "INSERT INTO note_view(raw_path, name, rule_json, display_json, "
            "sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                raw_path,
                name.strip() or "Untitled",
                json.dumps(rule or {}, ensure_ascii=False),
                json.dumps(display or {}, ensure_ascii=False),
                int(max_sort) + 1,
                now, now,
            ),
        )
        conn.commit()
        view_id = cur.lastrowid
    return get_view(view_id)  # type: ignore[return-value]


def update_view(
    view_id: int,
    name: str | None = None,
    rule: dict | None = None,
    display: dict | None = None,
    sort_order: int | None = None,
) -> dict | None:
    now = _now_iso()
    sets, args = [], []
    if name is not None:
        sets.append("name = ?"); args.append(name.strip() or "Untitled")
    if rule is not None:
        sets.append("rule_json = ?"); args.append(json.dumps(rule, ensure_ascii=False))
    if display is not None:
        sets.append("display_json = ?"); args.append(json.dumps(display, ensure_ascii=False))
    if sort_order is not None:
        sets.append("sort_order = ?"); args.append(int(sort_order))
    if not sets:
        return get_view(view_id)
    sets.append("updated_at = ?"); args.append(now)
    args.append(view_id)
    with connect() as conn:
        conn.execute(f"UPDATE note_view SET {', '.join(sets)} WHERE id = ?", args)
        conn.commit()
    return get_view(view_id)


def delete_view(view_id: int) -> None:
    with connect() as conn:
        conn.execute("DELETE FROM note_view WHERE id = ?", (view_id,))
        conn.commit()


# ── Membership ──────────────────────────────────────────────────

def list_members(view_id: int, include_excluded: bool = False) -> list[dict]:
    q = ("SELECT line_hash, source, excluded, line_preview, updated_at "
         "FROM note_view_member WHERE view_id = ?")
    if not include_excluded:
        q += " AND excluded = 0"
    with connect() as conn:
        rows = conn.execute(q, (view_id,)).fetchall()
    return [dict(r) for r in rows]


def _upsert_member(conn, view_id: int, line_hash: str, source: str,
                   line_preview: str, excluded: int | None = None) -> None:
    now = _now_iso()
    existing = conn.execute(
        "SELECT source, excluded FROM note_view_member "
        "WHERE view_id = ? AND line_hash = ?",
        (view_id, line_hash),
    ).fetchone()
    if not existing:
        conn.execute(
            "INSERT INTO note_view_member(view_id, line_hash, source, excluded, "
            "line_preview, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
            (view_id, line_hash, source, int(excluded or 0),
             (line_preview or "")[:200], now),
        )
        return
    # Update policy:
    #   - 'manual' adds always win: if a rule/ai hit exists and user manually
    #     adds it, promote source to 'manual' and clear excluded.
    #   - rule/ai re-populate must NOT resurrect a manually-excluded row.
    sets, args = [], []
    if source == "manual":
        sets += ["source = ?", "excluded = 0"]
        args += ["manual"]
    else:
        if existing["excluded"]:
            return  # respect user's manual exclusion
        if existing["source"] == "manual":
            return  # don't downgrade manual → rule
        sets += ["source = ?"]; args += [source]
    if excluded is not None:
        sets = [s for s in sets if s != "excluded = 0"]
        sets.append("excluded = ?"); args.append(int(excluded))
    if line_preview:
        sets.append("line_preview = ?"); args.append(line_preview[:200])
    sets.append("updated_at = ?"); args.append(now)
    args += [view_id, line_hash]
    conn.execute(
        f"UPDATE note_view_member SET {', '.join(sets)} "
        f"WHERE view_id = ? AND line_hash = ?",
        args,
    )


def set_members(
    view_id: int,
    add: list[dict] | None = None,      # [{line_hash, line_preview?}]
    remove: list[str] | None = None,    # [line_hash]
    exclude: list[dict] | None = None,  # [{line_hash, line_preview?}]
) -> dict:
    """Apply manual membership changes. `add` promotes to source='manual';
    `exclude` marks rule/ai hits as user-excluded without deleting the row
    (so a re-populate doesn't bring them back); `remove` deletes outright
    (used to undo a manual add)."""
    with connect() as conn:
        for m in add or []:
            _upsert_member(
                conn, view_id, m["line_hash"], "manual",
                m.get("line_preview", ""),
            )
        for m in exclude or []:
            _upsert_member(
                conn, view_id, m["line_hash"], "manual",
                m.get("line_preview", ""), excluded=1,
            )
        for h in remove or []:
            conn.execute(
                "DELETE FROM note_view_member WHERE view_id = ? AND line_hash = ?",
                (view_id, h),
            )
        conn.commit()
    return {"count": len(list_members(view_id))}


# ── Populate ─────────────────────────────────────────────────────

def populate(view_id: int, rule: dict | None = None, replace: bool = False) -> dict:
    """Run rule + AI population for a view. If `rule` is passed, it overwrites
    the stored rule before populating. If `replace=True`, all existing rule/ai
    rows are wiped first (manual stays untouched); otherwise we additively
    merge hits with existing members."""
    view = get_view(view_id)
    if not view:
        return {"ok": False, "error": "view not found"}
    if rule is not None:
        update_view(view_id, rule=rule)
        view = get_view(view_id)
    active_rule: dict = view["rule"] or {}  # type: ignore[assignment]

    keywords: list[str] = [k for k in (active_rule.get("keywords") or []) if k]
    regex_src: str = active_rule.get("regex") or ""
    ai_query: str = active_rule.get("ai_query") or ""

    raw_path: str = view["raw_path"]
    lines = _read_file_lines(raw_path)

    hits: dict[str, tuple[str, str]] = {}  # line_hash -> (source, preview)

    if keywords:
        needles = [k.lower() for k in keywords]
        for line in lines:
            if not line.strip():
                continue
            low = line.lower()
            if any(n in low for n in needles):
                h = _line_hash(line)
                hits.setdefault(h, ("rule", line.strip()[:200]))

    if regex_src:
        try:
            pat = re.compile(regex_src, re.IGNORECASE)
            for line in lines:
                if not line.strip():
                    continue
                if pat.search(line):
                    h = _line_hash(line)
                    hits.setdefault(h, ("rule", line.strip()[:200]))
        except re.error:
            pass  # malformed regex — skip silently

    ai_hit_count = 0
    if ai_query.strip():
        ai_hits = _ai_populate(raw_path, ai_query, lines)
        for h, preview in ai_hits.items():
            if h not in hits:
                hits[h] = ("ai", preview)
                ai_hit_count += 1

    with connect() as conn:
        if replace:
            conn.execute(
                "DELETE FROM note_view_member WHERE view_id = ? "
                "AND source IN ('rule', 'ai') AND excluded = 0",
                (view_id,),
            )
        for h, (src, preview) in hits.items():
            _upsert_member(conn, view_id, h, src, preview)
        conn.commit()

    return {
        "ok": True,
        "view_id": view_id,
        "rule_hits": sum(1 for v in hits.values() if v[0] == "rule"),
        "ai_hits": ai_hit_count,
        "total_hits": len(hits),
    }


def _ai_populate(raw_path: str, query: str, lines: list[str]) -> dict[str, str]:
    """Semantic populate via the existing retrieval pipeline. Takes top-N
    chunks whose source_file matches this note, splits their text into
    lines, and hashes any that appear in the current file. Hashing-against-
    file is how we stay correct even when the indexed chunk text drifts
    from the file after edits."""
    try:
        from app.retrieval import search as _search
    except Exception:
        return {}

    try:
        result = _search(query, topk=25) or {}
    except Exception:
        return {}

    file_line_set: dict[str, str] = {}
    for ln in lines:
        s = ln.strip()
        if not s:
            continue
        file_line_set[_line_hash(ln)] = s[:200]

    hits: dict[str, str] = {}
    for r in result.get("results", []):
        src_file = r.get("source_file") or r.get("sourceFile") or ""
        if src_file and src_file != raw_path:
            # retrieval returns chunks from other files too; filter to ours.
            continue
        text = r.get("text") or ""
        for ln in text.split("\n"):
            if not ln.strip():
                continue
            h = _line_hash(ln)
            if h in file_line_set and h not in hits:
                hits[h] = file_line_set[h]
    return hits


# ── Resolve ──────────────────────────────────────────────────────

def resolve(view_id: int, raw_path: str | None = None) -> dict:
    """Resolve view members to current line numbers in the source file.
    Returns `lines`: [{line_no, line_hash, text, source}] sorted by line_no,
    plus `missing`: hashes whose lines aren't currently in the file (they may
    have been deleted or heavily edited)."""
    view = get_view(view_id)
    if not view:
        return {"lines": [], "missing": []}
    path = raw_path or view["raw_path"]
    members = list_members(view_id, include_excluded=False)
    want: dict[str, str] = {m["line_hash"]: m["source"] for m in members}
    if not want:
        return {"lines": [], "missing": []}

    file_lines = _read_file_lines(path)
    found: list[dict] = []
    seen: set[str] = set()
    for i, ln in enumerate(file_lines, start=1):
        if not ln.strip():
            continue
        h = _line_hash(ln)
        if h in want and h not in seen:
            found.append({
                "line_no": i,
                "line_hash": h,
                "text": ln,
                "source": want[h],
            })
            seen.add(h)
    missing = [h for h in want.keys() if h not in seen]
    found.sort(key=lambda r: r["line_no"])
    return {"lines": found, "missing": missing}
