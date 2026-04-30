"""SmartNote local ↔ SmartNote Cloud bidirectional sync.

Local entities (notes, wiki topics, smart tables) are serialized into
cloud `document` records. Every document carries a `metadata` blob
identifying what local entity it came from, so any client — our own
desktop app, an AI CLI with the workspace API key, another user's
device — can reconstruct the shape it wants.

Sync is driven by content hashes + cloud `updated_at`. For each
entity:
  * hash the current local serialization
  * look up sync_state.(local_hash, remote_hash, remote_updated_at)
  * decide to push / pull / skip based on which side changed since
    the last successful round

Conflict policy is last-writer-wins keyed on `updated_at`: whoever
touched the row last wins, but the displaced content is stashed in
`sync_conflicts` so the user can recover from the Settings UI (or
manually via DB).

Wiki-topic sync is scaffolded but the serializer just returns an
empty set for now — wiki content on the local side lives as files
under `wiki_sources_dir` and we'll wire it in the next pass. Notes +
smart tables cover the common dogfood case.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterable

import httpx

from app import skill, smart_table
from app.config import settings as app_settings
from app.db import connect

log = logging.getLogger(__name__)


# ── JWT cache (so we don't re-exchange the api key on every call) ─

_jwt_cache: dict[str, tuple[str, int]] = {}
_jwt_lock = threading.Lock()
_JWT_MARGIN = 30  # refresh this many seconds before expiry


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _bundle_hash(metadata: dict | None) -> str:
    """Stable hash of the per-note bundle embedded in metadata. Empty
    bundle returns the empty string so legacy docs (no bundle) get a
    hash equal to sha256(content) — backward compatible."""
    bundle = (metadata or {}).get("smartnote_note") or {}
    if not bundle:
        return ""
    return _sha256(json.dumps(bundle, sort_keys=True, default=str))


def _content_hash(content: str, metadata: dict | None = None) -> str:
    """Hash that captures both the file content AND the per-note bundle
    (views / line marks / tag segments). Used everywhere we compare
    local vs remote so a bookmark change still moves the hash even
    when the file body didn't change."""
    bh = _bundle_hash(metadata)
    return _sha256(content) if not bh else _sha256(content + "\n---bundle---\n" + bh)


def _sanitize_content(text: str) -> str:
    """Postgres TEXT columns can't hold NUL bytes, and some scraped
    wiki files (esp. Chinese copies from PDFs) carry stray \\x00s.
    Strip them before sending; nothing user-meaningful is lost."""
    return text.replace("\x00", "") if "\x00" in text else text


def _cfg() -> tuple[str, str]:
    url = (getattr(app_settings, "cloud_sync_url", "") or "").rstrip("/")
    key = getattr(app_settings, "cloud_sync_api_key", "") or ""
    return url, key


def _ensure_configured() -> tuple[str, str]:
    url, key = _cfg()
    if not url or not key:
        raise RuntimeError(
            "Cloud sync not configured — set cloud_sync_url and "
            "cloud_sync_api_key in Settings."
        )
    return url, key


def _get_jwt(url: str, key: str) -> str:
    import time

    with _jwt_lock:
        cached = _jwt_cache.get(key)
        if cached and cached[1] > int(time.time()) + _JWT_MARGIN:
            return cached[0]
    with httpx.Client(timeout=10.0) as c:
        r = c.post(f"{url}/v1/auth/token", json={"api_key": key})
    r.raise_for_status()
    data = r.json()
    jwt = data["jwt"]
    exp = int(data["expires_at"])
    with _jwt_lock:
        _jwt_cache[key] = (jwt, exp)
    return jwt


def _cloud_request(
    method: str,
    path: str,
    *,
    json_body: Any | None = None,
    params: dict | None = None,
) -> httpx.Response:
    url, key = _ensure_configured()
    jwt = _get_jwt(url, key)
    with httpx.Client(timeout=30.0) as c:
        r = c.request(
            method,
            f"{url}{path}",
            json=json_body,
            params=params,
            headers={"Authorization": f"Bearer {jwt}"},
        )
        if r.status_code == 401:
            # JWT died mid-flight; drop cache + retry once.
            with _jwt_lock:
                _jwt_cache.pop(key, None)
            jwt = _get_jwt(url, key)
            r = c.request(
                method,
                f"{url}{path}",
                json=json_body,
                params=params,
                headers={"Authorization": f"Bearer {jwt}"},
            )
    return r


# ── Serializers ────────────────────────────────────────────────


@dataclass
class LocalEntity:
    """A thing on the local side that we sync. `local_id` is the key
    stored in sync_state (file path / topic name / table name)."""

    kind: str  # 'note' | 'wiki_topic' | 'smart_table'
    local_id: str
    name: str  # human-readable (shown in cloud listing)
    content: str  # canonical serialized form
    metadata: dict


def _gather_note_bundle(path: str) -> dict:
    """Per-note state that lives outside the file itself:
       - custom views the user defined for this file (note_view) and
         their line memberships (note_view_member)
       - per-line marks (note_lines: bookmarks, highlights, timestamps)
       - AI tag classifications (tag_segments) — keep so a fresh
         install doesn't have to re-pay the LLM for re-enrichment

    Everything is keyed by line_hash, which is content-addressable, so
    after restoring on a different machine the marks still find their
    lines as long as the line text matches.
    """
    bundle: dict[str, Any] = {"views": [], "lines": [], "segments": []}
    with connect() as conn:
        view_rows = conn.execute(
            "SELECT id, name, rule_json, display_json, sort_order, created_at, updated_at "
            "FROM note_view WHERE raw_path = ? ORDER BY sort_order, id",
            (path,),
        ).fetchall()
        for v in view_rows:
            members = conn.execute(
                "SELECT line_hash, source, excluded, ord FROM note_view_member "
                "WHERE view_id = ? ORDER BY ord, line_hash",
                (v[0],),
            ).fetchall()
            bundle["views"].append(
                {
                    "name": v[1],
                    "rule_json": v[2],
                    "display_json": v[3],
                    "sort_order": v[4],
                    "created_at": v[5],
                    "updated_at": v[6],
                    "members": [
                        {
                            "line_hash": m[0],
                            "source": m[1],
                            "excluded": m[2],
                            "ord": m[3],
                        }
                        for m in members
                    ],
                }
            )
        for r in conn.execute(
            "SELECT line_hash, line_no_last, line_preview, ts, bookmark, "
            "highlight_color, highlight_note FROM note_lines WHERE file_path = ? "
            "ORDER BY line_no_last",
            (path,),
        ).fetchall():
            bundle["lines"].append(
                {
                    "line_hash": r[0],
                    "line_no_last": r[1],
                    "line_preview": r[2],
                    "ts": r[3],
                    "bookmark": r[4],
                    "highlight_color": r[5],
                    "highlight_note": r[6],
                }
            )
        # tag_segments: AI classifications. We preserve them across
        # devices so a freshly-pulled install doesn't have to re-pay
        # the LLM. They get rebuilt on next ingest, but keeping them
        # avoids that round-trip on the recovery path.
        try:
            seg_rows = conn.execute(
                "SELECT tag, topic_name, line_start, line_end, summary, "
                "keywords_json FROM tag_segments WHERE source_file = ? "
                "ORDER BY line_start",
                (path,),
            ).fetchall()
            bundle["segments"] = [
                {
                    "tag": s[0],
                    "topic_name": s[1],
                    "line_start": s[2],
                    "line_end": s[3],
                    "summary": s[4],
                    "keywords_json": s[5],
                }
                for s in seg_rows
            ]
        except Exception:
            # tag_segments may have extra columns we didn't ask for, or
            # the table may not exist on a stripped-down install. Either
            # way, an empty segments list is the safe default.
            bundle["segments"] = []
    return bundle


def _serialize_note(path: str) -> LocalEntity | None:
    try:
        content = _sanitize_content(Path(path).read_text(encoding="utf-8"))
    except OSError:
        return None
    # Drop filenames to their basename for the cloud UI; full path
    # preserved in metadata.
    name = Path(path).name
    bundle = _gather_note_bundle(path)
    return LocalEntity(
        kind="note",
        local_id=path,
        name=name,
        content=content,
        metadata={
            "smartnote_type": "note",
            "local_path": path,
            "content_md5": hashlib.md5(content.encode("utf-8")).hexdigest(),
            # smartnote_note is the per-note bundle: views, line marks,
            # tag segments. Hashed alongside content so any of these
            # changing fires a push.
            "smartnote_note": bundle,
        },
    )


def _discover_notes() -> list[str]:
    """Which notes does this install sync? Three sources unioned:
      - note_lines.file_path  (every file the user has saved through
        /note/save)
      - ingest_packs.raw_path (files ingested but not yet saved)
      - sync_state rows with local_kind='note'  (files that arrived
        via pull and wouldn't otherwise be known locally yet)
    The last one is crucial: once a note is pulled from the cloud we
    need to keep syncing it even before the user opens and saves it
    locally."""
    paths: set[str] = set()
    with connect() as conn:
        for r in conn.execute("SELECT DISTINCT file_path FROM note_lines").fetchall():
            if r[0]:
                paths.add(r[0])
        for r in conn.execute("SELECT DISTINCT raw_path FROM ingest_packs").fetchall():
            if r[0]:
                paths.add(r[0])
        for r in conn.execute(
            "SELECT local_id FROM sync_state WHERE local_kind = 'note'"
        ).fetchall():
            if r[0]:
                paths.add(r[0])
    return sorted(paths)


def _serialize_smart_table(table_name: str) -> LocalEntity | None:
    """Dump every sheet of a table into one canonical JSON document.
    Hashing that JSON is how we detect local change — cell edits bump
    updated_at, which is included, so the hash moves on any touch."""
    try:
        sheets = smart_table.list_sheets(table_name)
    except Exception:
        return None
    payload: dict[str, Any] = {
        "table_name": table_name,
        "sheets": [],
    }
    for sheet_meta in sheets:
        try:
            # NB: the public API is `get_sheet`, not `read_sheet`. A
            # typo here used to swallow the exception below and drop
            # every sheet silently, so row/column edits never moved
            # the content hash — local changes showed up as "no delta"
            # in cloud sync. Keep this call right.
            sheet = smart_table.get_sheet(table_name, sheet_meta["name"])
        except Exception as e:
            log.warning(
                "serialize_smart_table: skipping sheet %s (%s)",
                sheet_meta.get("name"),
                e,
            )
            continue
        payload["sheets"].append(sheet)
    # Sort keys for stable serialization — otherwise dict ordering
    # would flutter the hash and cause spurious re-pushes.
    content = json.dumps(payload, ensure_ascii=False, sort_keys=True, default=str)
    return LocalEntity(
        kind="smart_table",
        local_id=table_name,
        name=f"smart-table: {table_name}",
        content=content,
        metadata={
            "smartnote_type": "smart_table",
            "table_name": table_name,
            "sheet_count": len(payload["sheets"]),
        },
    )


def _discover_smart_tables() -> list[str]:
    try:
        return [t["name"] for t in smart_table.list_tables()]
    except Exception:
        return []


def _wiki_root() -> Path | None:
    """Where on disk wiki source docs live. Can be empty if the user
    never set it — in which case wiki sync is a no-op."""
    raw = getattr(app_settings, "wiki_sources_dir", "") or ""
    if not raw:
        return None
    p = Path(raw).expanduser()
    return p if p.exists() else None


def _discover_wiki_topics() -> list[str]:
    """Recursively find every .md / .markdown under wiki_sources_dir,
    plus any files pulled previously (tracked in sync_state). The
    local_id is the absolute file path — same shape as notes, just a
    separate namespace so the pull path can write them into
    wiki_sources_dir instead of treating them as general notes."""
    paths: set[str] = set()
    root = _wiki_root()
    if root:
        for ext in ("*.md", "*.markdown"):
            for f in root.rglob(ext):
                if f.is_file():
                    paths.add(str(f.resolve()))
    with connect() as conn:
        for r in conn.execute(
            "SELECT local_id FROM sync_state WHERE local_kind = 'wiki_topic'"
        ).fetchall():
            if r[0]:
                paths.add(r[0])
    return sorted(paths)


def _serialize_wiki_topic(path: str) -> LocalEntity | None:
    try:
        content = _sanitize_content(Path(path).read_text(encoding="utf-8"))
    except OSError:
        return None
    root = _wiki_root()
    # Relative path for display ("foo/bar.md") when possible; absolute
    # otherwise. Always full path in metadata so pull knows where to land.
    rel = path
    if root:
        try:
            rel = str(Path(path).relative_to(root))
        except ValueError:
            pass
    return LocalEntity(
        kind="wiki_topic",
        local_id=path,
        name=rel,
        content=content,
        metadata={
            "smartnote_type": "wiki_topic",
            "local_path": path,
            "wiki_root": str(root) if root else "",
            "relative_path": rel,
            "content_md5": hashlib.md5(content.encode("utf-8")).hexdigest(),
        },
    )


def _discover_skills() -> list[str]:
    """Every skill template known locally. Skills are structured rows in
    `skill_templates` (not files), so the local_id is the template name
    — same as the natural addressing users already see in the Skills
    panel + MCP tools."""
    names: set[str] = set()
    try:
        for t in skill.list_templates():
            if t.get("name"):
                names.add(t["name"])
    except Exception:
        pass
    with connect() as conn:
        for r in conn.execute(
            "SELECT local_id FROM sync_state WHERE local_kind = 'skill'"
        ).fetchall():
            if r[0]:
                names.add(r[0])
    return sorted(names)


def _serialize_skill(name: str) -> LocalEntity | None:
    """Dump a template to canonical JSON. Hashing this representation
    detects any change — node edits, renames of nodes, period_hint
    flips — because those all change the JSON. Reuses the shape
    `skill.save_template` expects so the applier is a clean round-trip."""
    try:
        t = skill.get_template(name)
    except Exception:
        return None
    payload = {
        "name": t["name"],
        "description": t.get("description") or "",
        "kind": t.get("kind") or "periodic",
        "period_hint": t.get("period_hint") or "weekly",
        "nodes": t.get("nodes") or [],
        "source_segment_ids": t.get("source_segment_ids") or [],
    }
    content = json.dumps(payload, ensure_ascii=False, sort_keys=True, default=str)
    return LocalEntity(
        kind="skill",
        local_id=name,
        name=f"skill: {name}",
        content=content,
        metadata={
            "smartnote_type": "skill",
            "skill_name": name,
            "node_count": len(payload["nodes"]),
            "period_hint": payload["period_hint"],
        },
    )


def _apply_remote_skill(local_id: str, content: str) -> None:
    """Re-hydrate the skill template from the cloud snapshot. upsert by
    name so an existing local template with the same name gets updated
    in place; a new name creates a new row. Skill runs history is NOT
    touched — runs are local event logs, not part of the synced shape."""
    data = json.loads(content)
    skill.save_template(
        name=data.get("name") or local_id,
        description=data.get("description") or "",
        nodes=data.get("nodes") or [],
        kind=data.get("kind") or "periodic",
        period_hint=data.get("period_hint") or "weekly",
        source_segment_ids=data.get("source_segment_ids") or [],
    )


def _apply_remote_wiki_topic(local_id: str, content: str) -> None:
    """Write the remote wiki doc to its absolute local path. We do
    create missing parent directories here (unlike notes) because wiki
    content lives under a known root — creating a nested topic
    directory is expected behavior."""
    root = _wiki_root()
    path = Path(local_id)
    # Safety: refuse to land outside wiki_root if one is configured.
    if root and root not in path.resolve().parents and path != root / path.name:
        try:
            path.resolve().relative_to(root.resolve())
        except ValueError:
            raise RuntimeError(
                f"refusing to write wiki doc outside wiki_sources_dir: {path}"
            )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


# Registry: kind -> (discover, serialize, apply_local).
#
# ── Knowledge model ──────────────────────────────────────────
# SmartNote splits data into two tiers:
#   * SOURCE OF TRUTH — things the user wrote or imported. Must sync.
#     - notes       (raw .txt / .md files)
#     - wiki_topic  (.md under wiki_sources_dir)
#     - smart_table (user-curated structured tables)
#     - skill       (skill_templates rows — recipes)
#   * DERIVED INDEX — things we can rebuild from source. DON'T sync.
#     - chunks / chunks_fts / ivfflat embeddings
#     - tag_segments (AI enrich classification output)
#     - entities / entity_links / knowledge graph
#     - search_history / query_profiles / adaptive weights
#     - answer_cache / qa_memories
#     - ingest_packs / ingest diffs
# Rule of thumb: if it can be regenerated by re-running ingest against
# the synced source, it belongs in DERIVED INDEX. Sync the inputs; let
# each device / agent build its own index.
_REGISTRY: dict[
    str, tuple[Callable[[], list[str]], Callable[[str], LocalEntity | None]]
] = {
    "note": (_discover_notes, _serialize_note),
    "smart_table": (_discover_smart_tables, _serialize_smart_table),
    "wiki_topic": (_discover_wiki_topics, _serialize_wiki_topic),
    "skill": (_discover_skills, _serialize_skill),
}


def _apply_remote_note(
    local_id: str, content: str, metadata: dict | None = None
) -> None:
    """Overwrite the local note file AND restore the per-note bundle
    (custom views, line marks, tag segments) from cloud metadata.

    The bundle is keyed by line_hash so it survives across machines
    even when absolute file paths differ. Bundle missing → only the
    file content is rewritten (legacy doc shape, backward compatible).
    """
    path = Path(local_id)
    if not path.parent.exists():
        raise RuntimeError(
            f"refusing to apply remote note: parent dir missing for {local_id}"
        )
    path.write_text(content, encoding="utf-8")

    bundle = (metadata or {}).get("smartnote_note") or {}
    if not bundle:
        return  # legacy doc — nothing more to restore

    with connect() as conn:
        # Wipe per-note state and rebuild from the bundle. This is a
        # destructive overwrite by design — the cloud is source of
        # truth on the pull path and we want bundle changes to be
        # idempotent (no orphaned rows from a previous version).
        conn.execute("DELETE FROM note_lines WHERE file_path = ?", (local_id,))
        for ln in bundle.get("lines") or []:
            conn.execute(
                "INSERT INTO note_lines (file_path, line_hash, line_no_last, "
                "line_preview, ts, bookmark, highlight_color, highlight_note) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    local_id,
                    ln.get("line_hash") or "",
                    int(ln.get("line_no_last") or 0),
                    ln.get("line_preview") or "",
                    ln.get("ts"),
                    ln.get("bookmark") or "",
                    ln.get("highlight_color") or "",
                    ln.get("highlight_note") or "",
                ),
            )

        # Views: delete existing for this raw_path then re-insert.
        # note_view_member rows cascade on view_id deletion if FK is
        # set, but be explicit so this works on either schema.
        old_view_ids = [
            r[0]
            for r in conn.execute(
                "SELECT id FROM note_view WHERE raw_path = ?", (local_id,)
            ).fetchall()
        ]
        if old_view_ids:
            placeholders = ",".join("?" * len(old_view_ids))
            conn.execute(
                f"DELETE FROM note_view_member WHERE view_id IN ({placeholders})",
                old_view_ids,
            )
        conn.execute("DELETE FROM note_view WHERE raw_path = ?", (local_id,))
        for v in bundle.get("views") or []:
            cur = conn.execute(
                "INSERT INTO note_view (raw_path, name, rule_json, display_json, "
                "sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (
                    local_id,
                    v.get("name") or "(unnamed)",
                    v.get("rule_json") or "{}",
                    v.get("display_json") or "{}",
                    int(v.get("sort_order") or 0),
                    v.get("created_at"),
                    v.get("updated_at"),
                ),
            )
            new_view_id = cur.lastrowid
            for m in v.get("members") or []:
                conn.execute(
                    "INSERT INTO note_view_member (view_id, line_hash, source, excluded, ord) "
                    "VALUES (?, ?, ?, ?, ?)",
                    (
                        new_view_id,
                        m.get("line_hash") or "",
                        m.get("source") or "manual",
                        int(m.get("excluded") or 0),
                        int(m.get("ord") or 0),
                    ),
                )

        # Tag segments — best-effort. If the table shape on this
        # install differs (extra columns, NOT NULL constraints we
        # don't know about), skip rather than fail the whole pull.
        try:
            conn.execute("DELETE FROM tag_segments WHERE source_file = ?", (local_id,))
            for s in bundle.get("segments") or []:
                conn.execute(
                    "INSERT INTO tag_segments (source_file, tag, topic_name, "
                    "line_start, line_end, summary, keywords_json) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (
                        local_id,
                        s.get("tag") or "others",
                        s.get("topic_name") or "",
                        int(s.get("line_start") or 1),
                        int(s.get("line_end") or 1),
                        s.get("summary") or "",
                        s.get("keywords_json") or "[]",
                    ),
                )
        except Exception as e:
            log.warning("tag_segments restore skipped for %s: %s", local_id, e)
        conn.commit()


def _apply_remote_smart_table(local_id: str, content: str) -> None:
    """Rebuild the local smart table from the remote JSON snapshot.
    Brute-force: nuke the local table then re-create from the payload.
    Cells and ordering come back exactly. Audit history (`smart_table_cell_history`) is NOT preserved — LWW sync
    treats the cloud snapshot as authoritative."""
    data = json.loads(content)
    table_name = data.get("table_name") or local_id
    # Delete existing table (cascade kills sheets/rows/cells).
    try:
        smart_table.delete_table(table_name)
    except Exception:
        pass
    smart_table.create_table(table_name)
    for sheet_payload in data.get("sheets", []):
        sheet_meta = sheet_payload["sheet"]
        sheet_name = sheet_meta["name"]
        smart_table.create_sheet(table_name, sheet_name)
        for col in sheet_payload.get("columns", []):
            smart_table.add_column(
                table_name,
                sheet_name,
                col["name"],
                col.get("type") or "text",
            )
        # Rebuild rows with preserved cell values. We go row-by-row so
        # we can re-use the existing add_row / update_cell APIs — this
        # is O(rows*cols) but MVP smart tables are tiny.
        col_by_name = {c["name"]: c for c in sheet_payload.get("columns", [])}
        col_id_remap: dict[int, str] = {}  # old-cloud-id → column name
        for c in sheet_payload.get("columns", []):
            col_id_remap[int(c["id"])] = c["name"]
        for row in sorted(sheet_payload.get("rows", []), key=lambda r: r.get("ord", 0)):
            local_row = smart_table.add_row(table_name, sheet_name, {})
            for col_id_str, value in (row.get("cells") or {}).items():
                col_id_int = int(col_id_str)
                col_name = col_id_remap.get(col_id_int)
                if not col_name or col_name not in col_by_name:
                    continue
                try:
                    smart_table.update_cell(
                        table_name,
                        sheet_name,
                        int(local_row["id"]),
                        col_name,
                        value,
                    )
                except Exception as e:
                    log.debug("update_cell during sync failed: %s", e)


_APPLIERS: dict[str, Callable[[str, str], None]] = {
    "note": _apply_remote_note,
    "smart_table": _apply_remote_smart_table,
    "wiki_topic": _apply_remote_wiki_topic,
    "skill": _apply_remote_skill,
}


# ── sync_state CRUD ─────────────────────────────────────────────


@dataclass
class SyncRow:
    local_kind: str
    local_id: str
    cloud_doc_id: str | None
    local_hash: str
    remote_hash: str
    remote_updated_at: str | None
    last_pushed_at: str | None
    last_pulled_at: str | None


def _get_state(kind: str, local_id: str) -> SyncRow | None:
    with connect() as conn:
        row = conn.execute(
            "SELECT local_kind, local_id, cloud_doc_id, local_hash, remote_hash, "
            "remote_updated_at, last_pushed_at, last_pulled_at "
            "FROM sync_state WHERE local_kind = ? AND local_id = ?",
            (kind, local_id),
        ).fetchone()
    if not row:
        return None
    return SyncRow(*[row[i] for i in range(8)])


def _upsert_state(
    kind: str,
    local_id: str,
    *,
    cloud_doc_id: str | None = None,
    local_hash: str | None = None,
    remote_hash: str | None = None,
    remote_updated_at: str | None = None,
    pushed: bool = False,
    pulled: bool = False,
) -> None:
    existing = _get_state(kind, local_id)
    now = _now_iso()
    with connect() as conn:
        if existing:
            sets = []
            args: list[Any] = []
            if cloud_doc_id is not None:
                sets.append("cloud_doc_id = ?")
                args.append(cloud_doc_id)
            if local_hash is not None:
                sets.append("local_hash = ?")
                args.append(local_hash)
            if remote_hash is not None:
                sets.append("remote_hash = ?")
                args.append(remote_hash)
            if remote_updated_at is not None:
                sets.append("remote_updated_at = ?")
                args.append(remote_updated_at)
            if pushed:
                sets.append("last_pushed_at = ?")
                args.append(now)
            if pulled:
                sets.append("last_pulled_at = ?")
                args.append(now)
            if not sets:
                return
            args.extend([kind, local_id])
            conn.execute(
                f"UPDATE sync_state SET {', '.join(sets)} "
                "WHERE local_kind = ? AND local_id = ?",
                args,
            )
        else:
            conn.execute(
                "INSERT INTO sync_state(local_kind, local_id, cloud_doc_id, "
                "  local_hash, remote_hash, remote_updated_at, "
                "  last_pushed_at, last_pulled_at) "
                "VALUES(?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    kind,
                    local_id,
                    cloud_doc_id,
                    local_hash or "",
                    remote_hash or "",
                    remote_updated_at,
                    now if pushed else None,
                    now if pulled else None,
                ),
            )
        conn.commit()


def _record_conflict(
    kind: str,
    local_id: str,
    cloud_doc_id: str | None,
    direction: str,
    lost_content: str,
) -> None:
    """Persist the side that lost an LWW round so the user can recover."""
    with connect() as conn:
        conn.execute(
            "INSERT INTO sync_conflicts(local_kind, local_id, cloud_doc_id, "
            "  direction, lost_content) VALUES (?, ?, ?, ?, ?)",
            (kind, local_id, cloud_doc_id, direction, lost_content),
        )
        conn.commit()


# ── Push / Pull / Full sync ─────────────────────────────────────


def _identifying_field(kind: str) -> str:
    """Which metadata field identifies the local entity for this kind.
    Used to find an existing cloud doc when sync_state is missing
    (e.g. after a clean reinstall) — without this, push would create
    duplicate cloud docs."""
    return {
        "note": "local_path",
        "wiki_topic": "local_path",
        "smart_table": "table_name",
        "skill": "skill_name",
    }.get(kind, "local_path")


def _find_remote_doc_id(kind: str, local_id: str) -> str | None:
    """Look up an existing cloud doc that matches this local entity by
    its identifying metadata field. Returns the cloud doc id or None.
    Falls back to scanning the kind's list when the cloud has no
    metadata-filter endpoint."""
    field = _identifying_field(kind)
    try:
        r = _cloud_request(
            "GET",
            "/v1/documents",
            params={"smartnote_type": kind, "limit": 500},
        )
        if r.status_code != 200:
            return None
        for doc in r.json().get("documents") or []:
            md = doc.get("metadata") or {}
            if md.get(field) == local_id:
                return doc.get("id")
    except Exception as e:
        log.debug("find_remote_doc_id failed for %s/%s: %s", kind, local_id, e)
    return None


def _push_entity(entity: LocalEntity) -> dict:
    state = _get_state(entity.kind, entity.local_id)
    local_hash = _content_hash(entity.content, entity.metadata)
    if state and state.local_hash == local_hash and state.cloud_doc_id:
        return {"action": "skip", "reason": "unchanged"}

    # Recover from missing sync_state: if the local row was wiped (clean
    # install, manual delete) but the cloud still has a matching doc,
    # adopt it instead of POSTing a duplicate.
    if not state or not state.cloud_doc_id:
        remote_id = _find_remote_doc_id(entity.kind, entity.local_id)
        if remote_id:
            _upsert_state(entity.kind, entity.local_id, cloud_doc_id=remote_id)
            state = _get_state(entity.kind, entity.local_id)

    if state and state.cloud_doc_id:
        # Detect push-over-remote-change: remote changed since we last
        # synced but we're about to overwrite. Save the remote snapshot
        # so the user can recover it.
        r_head = _cloud_request("GET", f"/v1/documents/{state.cloud_doc_id}")
        if r_head.status_code == 200:
            remote = r_head.json()
            remote_hash = _content_hash(
                remote.get("content") or "", remote.get("metadata")
            )
            if state.remote_hash and remote_hash != state.remote_hash:
                _record_conflict(
                    entity.kind,
                    entity.local_id,
                    state.cloud_doc_id,
                    "push_overwrote_remote",
                    remote.get("content") or "",
                )
        # Patch existing doc.
        r = _cloud_request(
            "PATCH",
            f"/v1/documents/{state.cloud_doc_id}",
            json_body={
                "name": entity.name,
                "content": entity.content,
                "metadata": entity.metadata,
            },
        )
        r.raise_for_status()
        doc = r.json()
        _upsert_state(
            entity.kind,
            entity.local_id,
            cloud_doc_id=doc["id"],
            local_hash=local_hash,
            remote_hash=local_hash,  # parity after push
            remote_updated_at=doc.get("updated_at"),
            pushed=True,
        )
        return {"action": "update", "cloud_doc_id": doc["id"]}

    # First push — POST.
    r = _cloud_request(
        "POST",
        "/v1/documents",
        json_body={
            "name": entity.name,
            "content": entity.content,
            "kind": "text",
            "metadata": entity.metadata,
        },
    )
    r.raise_for_status()
    doc = r.json()
    _upsert_state(
        entity.kind,
        entity.local_id,
        cloud_doc_id=doc["id"],
        local_hash=local_hash,
        remote_hash=local_hash,
        remote_updated_at=doc.get("updated_at") or doc.get("created_at"),
        pushed=True,
    )
    # Trigger server-side ingest in the background so retrieve() picks
    # up the new content. Non-fatal on failure — sync itself succeeded.
    try:
        _cloud_request(
            "POST", "/v1/ingest/document", json_body={"document_id": doc["id"]}
        )
    except Exception as e:
        log.debug("post-push ingest kick failed: %s", e)
    return {"action": "create", "cloud_doc_id": doc["id"]}


def push_one(kind: str, local_id: str) -> dict:
    """Push a single entity by (kind, local_id).

    Powers the client-side per-item upload loop that gives progress
    feedback and cancellability — the client fetches `preview()` for
    the item list, then POSTs /sync/push-one for each, checking its
    AbortController between calls. Server stays stateless; cancel =
    client just stops asking."""
    if kind not in _REGISTRY:
        return {"action": "error", "error": f"unknown kind: {kind}"}
    _, serialize = _REGISTRY[kind]
    entity = serialize(local_id)
    if not entity:
        return {"action": "error", "error": f"serialize returned None for {local_id}"}
    try:
        return _push_entity(entity)
    except Exception as e:
        return {"action": "error", "error": str(e)}


def push_all() -> dict:
    """Iterate every local entity kind, push whatever has drifted from
    its recorded state. Returns a summary suitable for rendering in the
    Settings status panel."""
    summary: dict[str, list[dict]] = {}
    for kind, (discover, serialize) in _REGISTRY.items():
        summary[kind] = []
        for local_id in discover():
            entity = serialize(local_id)
            if not entity:
                continue
            try:
                result = _push_entity(entity)
            except Exception as e:
                result = {"action": "error", "error": str(e)}
            summary[kind].append({"local_id": local_id, **result})
    return {"pushed": summary}


def _resolve_local_id(doc: dict) -> tuple[str | None, str | None]:
    """Map a cloud document → (kind, local_id) used for sync_state +
    apply. Returns (None, None) when the doc is unrecognized or missing
    the metadata field we use to identify the local form."""
    meta = doc.get("metadata") or {}
    kind = meta.get("smartnote_type")
    if kind not in _REGISTRY:
        return None, None
    if kind == "note":
        return kind, meta.get("local_path")
    if kind == "smart_table":
        return kind, meta.get("table_name")
    if kind == "wiki_topic":
        local_id = meta.get("local_path")
        root = _wiki_root()
        if root and meta.get("relative_path"):
            local_id = str((root / meta["relative_path"]).resolve())
        return kind, local_id
    if kind == "skill":
        return kind, meta.get("skill_name")
    return kind, None


def _classify_remote(doc: dict) -> dict:
    """Read-only classification of a single cloud doc — what *would*
    happen on apply. Mirrors `_apply_remote` decision logic without any
    writes. Used by `pull_diff` to power the UI preview.

    Returns one of:
      * { action: "in-sync" }
      * { action: "new", local_id, remote_size }
      * { action: "would-overwrite-clean", local_id, … }
      * { action: "would-overwrite-conflict", local_id, local_size, remote_size }
      * { action: "skip", reason }
    """
    kind, local_id = _resolve_local_id(doc)
    if kind is None:
        return {"action": "skip", "reason": "unknown smartnote_type"}
    if not local_id:
        return {"action": "skip", "reason": "missing local_id in metadata"}

    remote_content = doc.get("content") or ""
    remote_meta = doc.get("metadata") or {}
    remote_hash = _content_hash(remote_content, remote_meta)
    state = _get_state(kind, local_id)

    # Already in sync → nothing to show.
    if state and state.remote_hash == remote_hash and state.local_hash == remote_hash:
        return {"action": "in-sync", "kind": kind, "local_id": local_id}

    _, serializer = _REGISTRY[kind]
    current_local = serializer(local_id)
    local_size = len(current_local.content) if current_local else 0

    if not current_local:
        return {
            "action": "new",
            "kind": kind,
            "local_id": local_id,
            "remote_size": len(remote_content),
            "cloud_doc_id": doc.get("id"),
        }

    local_hash = _content_hash(current_local.content, current_local.metadata)
    if local_hash == remote_hash:
        return {"action": "in-sync", "kind": kind, "local_id": local_id}

    # Pure cloud-newer (local hasn't changed since last sync) — clean
    # overwrite, low risk. Local divergence (state.local_hash mismatch)
    # is the dangerous case we want to surface to the user.
    is_conflict = bool(state and state.local_hash and state.local_hash != local_hash)
    return {
        "action": "would-overwrite-conflict"
        if is_conflict
        else "would-overwrite-clean",
        "kind": kind,
        "local_id": local_id,
        "local_size": local_size,
        "remote_size": len(remote_content),
        "cloud_doc_id": doc.get("id"),
    }


def _apply_remote(doc: dict, *, force: bool = False) -> dict:
    """Handle a single remote document on the pull path: decide whether
    the remote is actually newer than local, apply if so.

    `force=True` skips the in-sync optimization AND the conflict
    recording — useful for "blow away local with cloud" recovery flows.
    Conflict snapshots are still saved when local diverged so the user
    can audit / unwind.
    """
    kind, local_id = _resolve_local_id(doc)
    if kind is None:
        return {"action": "skip", "reason": "unknown smartnote_type"}
    if not local_id:
        return {"action": "skip", "reason": "missing local_id in metadata"}

    state = _get_state(kind, local_id)
    remote_content = doc.get("content") or ""
    remote_meta = doc.get("metadata") or {}
    remote_hash = _content_hash(remote_content, remote_meta)

    # In-sync short-circuit. force=True bypasses so a "force pull" still
    # rewrites the local file even when hashes match — useful when the
    # local file is corrupted but the hash table thinks it's fine.
    if (
        not force
        and state
        and state.remote_hash == remote_hash
        and state.local_hash == remote_hash
    ):
        return {"action": "skip", "reason": "in-sync"}

    _, serializer = _REGISTRY[kind]
    current_local = serializer(local_id)
    local_hash = (
        _content_hash(current_local.content, current_local.metadata)
        if current_local
        else ""
    )

    if state and local_hash and local_hash != state.local_hash:
        # Local changed since last sync — conflict. LWW: whoever has
        # the newer updated_at wins. We don't have a reliable local
        # updated_at, so we fall back to "remote wins if remote changed
        # too" — safer in the multi-device case than blindly keeping
        # stale local. Stash the local snapshot for recovery.
        if local_hash != remote_hash:
            _record_conflict(
                kind,
                local_id,
                doc.get("id"),
                "force_pull_overwrote_local" if force else "pull_overwrote_local",
                current_local.content if current_local else "",
            )
    apply_fn = _APPLIERS.get(kind)
    if not apply_fn:
        return {"action": "skip", "reason": f"no applier for {kind}"}
    try:
        # Appliers accept metadata so per-kind bundles (note views,
        # marks, etc.) can be restored. Older signatures that only
        # take (local_id, content) are still supported via a try/
        # fallback so we don't break existing kinds.
        try:
            apply_fn(local_id, remote_content, remote_meta)
        except TypeError:
            apply_fn(local_id, remote_content)
    except Exception as e:
        return {"action": "error", "error": str(e)}

    _upsert_state(
        kind,
        local_id,
        cloud_doc_id=doc.get("id"),
        local_hash=remote_hash,  # after apply, local == remote
        remote_hash=remote_hash,
        remote_updated_at=doc.get("updated_at") or doc.get("created_at"),
        pulled=True,
    )
    return {"action": "apply", "cloud_doc_id": doc.get("id")}


_PULL_KINDS = ("smart_table", "note", "wiki_topic", "skill")


def _iter_remote_docs(force: bool):
    """Generator: yields full cloud documents one at a time for every
    syncable kind. When force=True the watermark is ignored so we see
    EVERY remote doc, not just ones newer than last pull."""
    with connect() as conn:
        row = conn.execute(
            "SELECT MAX(remote_updated_at) FROM sync_state WHERE remote_updated_at IS NOT NULL"
        ).fetchone()
    since = None if force else (row[0] if row and row[0] else None)

    for kind_filter in _PULL_KINDS:
        params: dict = {"smartnote_type": kind_filter}
        if since:
            params["since"] = since
        try:
            r = _cloud_request("GET", "/v1/documents", params=params)
            r.raise_for_status()
        except Exception as e:
            yield kind_filter, None, {"action": "error", "error": str(e)}
            continue
        for doc_brief in r.json().get("documents") or []:
            try:
                full = _cloud_request("GET", f"/v1/documents/{doc_brief['id']}")
                full.raise_for_status()
                yield kind_filter, full.json(), None
            except Exception as e:
                yield (
                    kind_filter,
                    None,
                    {
                        "action": "error",
                        "doc_id": doc_brief.get("id"),
                        "error": str(e),
                    },
                )


def pull_all(force: bool = False) -> dict:
    """Fetch every remote document the workspace has that we care about
    and apply it. Uses `since=` when we have a last-pull watermark to
    cut bandwidth.

    `force=True` ignores the watermark + skips in-sync short-circuit,
    so a corrupted-local recovery actually overwrites everything from
    cloud. Conflict snapshots are still saved when local has diverged.
    """
    summary: dict[str, list[dict]] = {k: [] for k in _PULL_KINDS}
    for kind, doc, err in _iter_remote_docs(force=force):
        if err is not None:
            summary[kind].append(err)
            continue
        if doc is None:
            continue
        result = _apply_remote(doc, force=force)
        summary[kind].append({"doc_id": doc.get("id"), **result})
    return {"pulled": summary, "force": force}


def dedupe_cloud() -> dict:
    """One-shot cleanup: find cloud documents whose identifying field
    (local_path / table_name / skill_name) matches another doc of the
    same kind, keep the newest, delete the rest. Heals duplicate-push
    bugs from older sync code paths.

    Returns counts per kind: { kept, deleted, errors }.
    """
    summary: dict[str, dict[str, int]] = {}
    for kind in _PULL_KINDS:
        field = _identifying_field(kind)
        try:
            r = _cloud_request(
                "GET",
                "/v1/documents",
                params={"smartnote_type": kind, "limit": 500},
            )
            r.raise_for_status()
        except Exception as e:
            summary[kind] = {"kept": 0, "deleted": 0, "errors": 1, "error": str(e)}
            continue
        docs = r.json().get("documents") or []
        # Group by identifying field; bucket-less docs (no field set) go
        # into a singleton group so they're never deleted by accident.
        groups: dict[str, list[dict]] = {}
        for doc in docs:
            key = (doc.get("metadata") or {}).get(field) or f"__no_id_{doc.get('id')}"
            groups.setdefault(key, []).append(doc)

        kept = deleted = errors = 0
        for key, group in groups.items():
            if len(group) == 1:
                kept += 1
                continue
            # Keep the newest (largest updated_at); delete the rest.
            group.sort(
                key=lambda d: d.get("updated_at") or d.get("created_at") or "",
                reverse=True,
            )
            kept += 1
            for d in group[1:]:
                try:
                    rd = _cloud_request("DELETE", f"/v1/documents/{d['id']}")
                    if rd.status_code in (200, 204):
                        deleted += 1
                    else:
                        errors += 1
                except Exception:
                    errors += 1
        summary[kind] = {"kept": kept, "deleted": deleted, "errors": errors}
    return summary


def pull_diff() -> dict:
    """Read-only preview of what `pull_all(force=True)` would do.

    Returns counts + per-doc rows so the UI can render a confirmation
    dialog ("about to overwrite N items, of which K diverge from
    cloud — proceed?"). Performs the same network fetches as
    `pull_all` but never writes.
    """
    rows: list[dict] = []
    counts = {
        "new": 0,
        "in-sync": 0,
        "would-overwrite-clean": 0,
        "would-overwrite-conflict": 0,
        "skip": 0,
        "error": 0,
    }
    for kind, doc, err in _iter_remote_docs(force=True):
        if err is not None:
            counts["error"] += 1
            rows.append({"kind": kind, **err})
            continue
        if doc is None:
            continue
        verdict = _classify_remote(doc)
        action = verdict.get("action", "skip")
        counts[action] = counts.get(action, 0) + 1
        rows.append({"cloud_doc_id": doc.get("id"), "name": doc.get("name"), **verdict})
    return {"counts": counts, "rows": rows}


def full_sync() -> dict:
    """Push then pull — single serial round. Rerun as needed; each
    pass converges further."""
    return {
        "push": push_all(),
        "pull": pull_all(),
        "finished_at": _now_iso(),
    }


def test_connection(
    override_url: str | None = None,
    override_api_key: str | None = None,
) -> dict:
    """Cheap "is my API key valid?" probe.

    Accepts optional URL + key overrides so the Settings UI can test
    the form values the user just typed without first having to hit
    the main Save button. When overrides are omitted, falls back to
    the persisted app_settings values.
    """
    url = (override_url or getattr(app_settings, "cloud_sync_url", "") or "").rstrip(
        "/"
    )
    key = override_api_key or getattr(app_settings, "cloud_sync_api_key", "") or ""
    if not url or not key:
        return {
            "ok": False,
            "error": "Fill in both Cloud API URL and API Key, then try again.",
        }
    # 1. Reachability: hitting /v1/health is unauthenticated and cheap.
    try:
        r_health = httpx.get(f"{url}/v1/health", timeout=5.0)
        r_health.raise_for_status()
    except Exception as e:
        return {"ok": False, "error": f"cloud unreachable at {url}: {e}"}
    # 2. Key validity: exchange for JWT, then GET /v1/usage which
    # requires memories:read scope (smallest permissible). Don't touch
    # the process-wide JWT cache — the form values may not match what
    # we'll actually sync with later.
    try:
        t = httpx.post(f"{url}/v1/auth/token", json={"api_key": key}, timeout=10.0)
        if t.status_code == 401:
            return {
                "ok": False,
                "error": "API key rejected (401) — check for typos or revocation.",
            }
        t.raise_for_status()
        jwt = t.json()["jwt"]
        r = httpx.get(
            f"{url}/v1/usage", headers={"Authorization": f"Bearer {jwt}"}, timeout=10.0
        )
        r.raise_for_status()
    except Exception as e:
        return {"ok": False, "error": f"credentials rejected: {e}"}
    return {"ok": True, "workspace": r.json()}


def preview() -> dict:
    """Dry-run discovery + sizing — what would push_all() upload?

    Runs the same discover + serialize steps but never calls the cloud.
    Powers the "Review & upload" pane the Settings UI shows before the
    first real sync, so users know exactly what leaves their machine.
    """
    per_kind: dict[str, dict] = {}
    for kind, (discover, serialize) in _REGISTRY.items():
        ids = discover()
        items: list[dict] = []
        total_bytes = 0
        new_count = 0
        changed_count = 0
        for local_id in ids:
            entity = serialize(local_id)
            if not entity:
                continue
            size = len(entity.content.encode("utf-8"))
            total_bytes += size
            state = _get_state(kind, local_id)
            h = _sha256(entity.content)
            if not state or not state.cloud_doc_id:
                status = "new"
                new_count += 1
            elif state.local_hash != h:
                status = "changed"
                changed_count += 1
            else:
                status = "unchanged"
            items.append(
                {
                    "local_id": local_id,
                    "name": entity.name,
                    "size": size,
                    "status": status,
                }
            )
        per_kind[kind] = {
            "count": len(items),
            "new": new_count,
            "changed": changed_count,
            "unchanged": len(items) - new_count - changed_count,
            "total_bytes": total_bytes,
            # Cap high enough to cover realistic wikis & note dirs (typical
            # MVP install: dozens–hundreds of files). If this ever gets
            # exceeded we should switch the preview to a paginated response;
            # for now 2000 is well under any JSON payload concern.
            "items": items[:2000],
            "truncated": len(items) > 2000,
        }
    totals = {
        "total_items": sum(k["count"] for k in per_kind.values()),
        "total_new": sum(k["new"] for k in per_kind.values()),
        "total_changed": sum(k["changed"] for k in per_kind.values()),
        "total_bytes": sum(k["total_bytes"] for k in per_kind.values()),
    }
    return {"kinds": per_kind, **totals}


# ── Cloud proposal queue proxy (for desktop Draft Inbox UI) ─────
# The desktop app stores cloud credentials once in app_settings; these
# helpers let the UI read/write the cloud-side proposal queue without
# having to also know the URL + key directly.


def list_cloud_proposals(kind: str | None = None, limit: int = 100) -> dict:
    params: dict[str, Any] = {"limit": limit}
    if kind:
        params["kind"] = kind
    r = _cloud_request("GET", "/v1/memories/proposals", params=params)
    r.raise_for_status()
    return r.json()


def accept_cloud_proposal(proposal_id: str, patch: dict | None = None) -> dict:
    """Promote a draft to active. `patch` can override content / tags /
    pinned / confidence / supersedes — keys the cloud accept endpoint
    understands."""
    r = _cloud_request(
        "POST",
        f"/v1/memories/proposals/{proposal_id}/accept",
        json_body=patch or {},
    )
    r.raise_for_status()
    return r.json()


def reject_cloud_proposal(proposal_id: str, reason: str | None = None) -> dict:
    r = _cloud_request(
        "POST",
        f"/v1/memories/proposals/{proposal_id}/reject",
        json_body={"reason": reason} if reason else {},
    )
    r.raise_for_status()
    return r.json()


def batch_accept_cloud_proposals(ids: list[str]) -> dict:
    r = _cloud_request(
        "POST",
        "/v1/memories/proposals/batch-accept",
        json_body={"ids": ids},
    )
    r.raise_for_status()
    return r.json()


def sync_status() -> dict:
    """Snapshot of sync_state for the Settings UI."""
    with connect() as conn:
        rows = conn.execute(
            "SELECT local_kind, COUNT(*) as n, MAX(last_pushed_at) as last_push, "
            "MAX(last_pulled_at) as last_pull FROM sync_state GROUP BY local_kind"
        ).fetchall()
        conflict_count = conn.execute("SELECT COUNT(*) FROM sync_conflicts").fetchone()[
            0
        ]
    enabled = bool(getattr(app_settings, "cloud_sync_enabled", False))
    url, key = _cfg()
    return {
        "enabled": enabled,
        "configured": bool(url and key),
        "cloud_url": url,
        "entities": [
            dict(zip(("local_kind", "count", "last_push", "last_pull"), r))
            for r in rows
        ],
        "conflicts": conflict_count,
    }
