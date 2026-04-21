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

from app import smart_table
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
    method: str, path: str, *,
    json_body: Any | None = None,
    params: dict | None = None,
) -> httpx.Response:
    url, key = _ensure_configured()
    jwt = _get_jwt(url, key)
    with httpx.Client(timeout=30.0) as c:
        r = c.request(
            method, f"{url}{path}",
            json=json_body, params=params,
            headers={"Authorization": f"Bearer {jwt}"},
        )
        if r.status_code == 401:
            # JWT died mid-flight; drop cache + retry once.
            with _jwt_lock:
                _jwt_cache.pop(key, None)
            jwt = _get_jwt(url, key)
            r = c.request(
                method, f"{url}{path}",
                json=json_body, params=params,
                headers={"Authorization": f"Bearer {jwt}"},
            )
    return r


# ── Serializers ────────────────────────────────────────────────

@dataclass
class LocalEntity:
    """A thing on the local side that we sync. `local_id` is the key
    stored in sync_state (file path / topic name / table name)."""
    kind: str                      # 'note' | 'wiki_topic' | 'smart_table'
    local_id: str
    name: str                      # human-readable (shown in cloud listing)
    content: str                   # canonical serialized form
    metadata: dict


def _serialize_note(path: str) -> LocalEntity | None:
    try:
        content = Path(path).read_text(encoding="utf-8")
    except OSError:
        return None
    # Drop filenames to their basename for the cloud UI; full path
    # preserved in metadata.
    name = Path(path).name
    return LocalEntity(
        kind="note",
        local_id=path,
        name=name,
        content=content,
        metadata={
            "smartnote_type": "note",
            "local_path": path,
            "content_md5": hashlib.md5(content.encode("utf-8")).hexdigest(),
        },
    )


def _discover_notes() -> list[str]:
    """Which notes does this install sync? We take every file path the
    local DB has per-line metadata for — that's the set of files the user
    has actually written through /note/save, which is the meaningful
    'my notes' set. Catches manual opens too (PackBadge adds entries on
    load)."""
    with connect() as conn:
        rows = conn.execute(
            "SELECT DISTINCT file_path FROM note_lines"
        ).fetchall()
    paths = [r[0] for r in rows if r[0]]
    # Include any raw_path referenced by ingest_packs too (covers files
    # that were ingested but haven't had a /note/save yet).
    with connect() as conn:
        more = conn.execute(
            "SELECT DISTINCT raw_path FROM ingest_packs"
        ).fetchall()
    for r in more:
        if r[0] and r[0] not in paths:
            paths.append(r[0])
    return paths


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
            sheet = smart_table.read_sheet(table_name, sheet_meta["name"])
        except Exception:
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


def _discover_wiki_topics() -> list[str]:
    # TODO: next pass — enumerate wiki docs under wiki_sources_dir and
    # sync them like notes. Leaving empty for now keeps the first sync
    # fast and avoids half-baked wiki serialization.
    return []


def _serialize_wiki_topic(topic: str) -> LocalEntity | None:
    return None


# Registry: kind -> (discover, serialize, apply_local)
_REGISTRY: dict[str, tuple[Callable[[], list[str]], Callable[[str], LocalEntity | None]]] = {
    "note": (_discover_notes, _serialize_note),
    "smart_table": (_discover_smart_tables, _serialize_smart_table),
    "wiki_topic": (_discover_wiki_topics, _serialize_wiki_topic),
}


def _apply_remote_note(local_id: str, content: str) -> None:
    """Overwrite the local note file. This is the LWW-pull path — we've
    already decided remote wins. We do a tiny safety check: don't write
    to a path that doesn't exist as a parent (i.e. don't create new
    directories from the cloud side)."""
    path = Path(local_id)
    if not path.parent.exists():
        raise RuntimeError(
            f"refusing to apply remote note: parent dir missing for {local_id}"
        )
    path.write_text(content, encoding="utf-8")


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
                table_name, sheet_name, col["name"], col.get("type") or "text",
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
                        table_name, sheet_name,
                        int(local_row["id"]), col_name, value,
                    )
                except Exception as e:
                    log.debug("update_cell during sync failed: %s", e)


_APPLIERS: dict[str, Callable[[str, str], None]] = {
    "note": _apply_remote_note,
    "smart_table": _apply_remote_smart_table,
    "wiki_topic": lambda _id, _c: None,   # TODO
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
    kind: str, local_id: str, *,
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
                sets.append("cloud_doc_id = ?"); args.append(cloud_doc_id)
            if local_hash is not None:
                sets.append("local_hash = ?"); args.append(local_hash)
            if remote_hash is not None:
                sets.append("remote_hash = ?"); args.append(remote_hash)
            if remote_updated_at is not None:
                sets.append("remote_updated_at = ?"); args.append(remote_updated_at)
            if pushed:
                sets.append("last_pushed_at = ?"); args.append(now)
            if pulled:
                sets.append("last_pulled_at = ?"); args.append(now)
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
                    kind, local_id, cloud_doc_id,
                    local_hash or "", remote_hash or "", remote_updated_at,
                    now if pushed else None,
                    now if pulled else None,
                ),
            )
        conn.commit()


def _record_conflict(
    kind: str, local_id: str, cloud_doc_id: str | None,
    direction: str, lost_content: str,
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

def _push_entity(entity: LocalEntity) -> dict:
    state = _get_state(entity.kind, entity.local_id)
    local_hash = _sha256(entity.content)
    if state and state.local_hash == local_hash and state.cloud_doc_id:
        return {"action": "skip", "reason": "unchanged"}

    if state and state.cloud_doc_id:
        # Detect push-over-remote-change: remote changed since we last
        # synced but we're about to overwrite. Save the remote snapshot
        # so the user can recover it.
        r_head = _cloud_request("GET", f"/v1/documents/{state.cloud_doc_id}")
        if r_head.status_code == 200:
            remote = r_head.json()
            remote_hash = _sha256(remote.get("content") or "")
            if state.remote_hash and remote_hash != state.remote_hash:
                _record_conflict(
                    entity.kind, entity.local_id, state.cloud_doc_id,
                    "push_overwrote_remote", remote.get("content") or "",
                )
        # Patch existing doc.
        r = _cloud_request(
            "PATCH", f"/v1/documents/{state.cloud_doc_id}",
            json_body={
                "name": entity.name,
                "content": entity.content,
                "metadata": entity.metadata,
            },
        )
        r.raise_for_status()
        doc = r.json()
        _upsert_state(
            entity.kind, entity.local_id,
            cloud_doc_id=doc["id"],
            local_hash=local_hash,
            remote_hash=local_hash,          # parity after push
            remote_updated_at=doc.get("updated_at"),
            pushed=True,
        )
        return {"action": "update", "cloud_doc_id": doc["id"]}

    # First push — POST.
    r = _cloud_request(
        "POST", "/v1/documents",
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
        entity.kind, entity.local_id,
        cloud_doc_id=doc["id"],
        local_hash=local_hash,
        remote_hash=local_hash,
        remote_updated_at=doc.get("updated_at") or doc.get("created_at"),
        pushed=True,
    )
    # Trigger server-side ingest in the background so retrieve() picks
    # up the new content. Non-fatal on failure — sync itself succeeded.
    try:
        _cloud_request("POST", f"/v1/documents/{doc['id']}/ingest")
    except Exception as e:
        log.debug("post-push ingest kick failed: %s", e)
    return {"action": "create", "cloud_doc_id": doc["id"]}


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


def _apply_remote(doc: dict) -> dict:
    """Handle a single remote document on the pull path: decide whether
    the remote is actually newer than local, apply if so."""
    meta = doc.get("metadata") or {}
    kind = meta.get("smartnote_type")
    if kind not in _REGISTRY:
        return {"action": "skip", "reason": "unknown smartnote_type"}

    # Reconstruct local_id from metadata — different per kind.
    if kind == "note":
        local_id = meta.get("local_path")
    elif kind == "smart_table":
        local_id = meta.get("table_name")
    elif kind == "wiki_topic":
        local_id = meta.get("topic_name")
    else:
        local_id = None
    if not local_id:
        return {"action": "skip", "reason": "missing local_id in metadata"}

    state = _get_state(kind, local_id)
    remote_content = doc.get("content") or ""
    remote_hash = _sha256(remote_content)

    # If we already have it in sync_state and the remote hash matches our
    # recorded remote_hash AND it also matches local_hash, nothing to do.
    if state and state.remote_hash == remote_hash and state.local_hash == remote_hash:
        return {"action": "skip", "reason": "in-sync"}

    # Serialize the current local form to compare.
    _, serializer = _REGISTRY[kind]
    current_local = serializer(local_id)
    local_hash = _sha256(current_local.content) if current_local else ""

    if state and local_hash and local_hash != state.local_hash:
        # Local changed since last sync — conflict. LWW: whoever has
        # the newer updated_at wins. We don't have a reliable local
        # updated_at, so we fall back to "remote wins if remote changed
        # too" — safer in the multi-device case than blindly keeping
        # stale local. Stash the local snapshot for recovery.
        if local_hash != remote_hash:
            _record_conflict(
                kind, local_id, doc.get("id"),
                "pull_overwrote_local", current_local.content if current_local else "",
            )
    apply_fn = _APPLIERS.get(kind)
    if not apply_fn:
        return {"action": "skip", "reason": f"no applier for {kind}"}
    try:
        apply_fn(local_id, remote_content)
    except Exception as e:
        return {"action": "error", "error": str(e)}

    _upsert_state(
        kind, local_id,
        cloud_doc_id=doc.get("id"),
        local_hash=remote_hash,       # after apply, local == remote
        remote_hash=remote_hash,
        remote_updated_at=doc.get("updated_at") or doc.get("created_at"),
        pulled=True,
    )
    return {"action": "apply", "cloud_doc_id": doc.get("id")}


def pull_all() -> dict:
    """Fetch every remote document the workspace has that we care about
    and apply it. Uses `since=` when we have a last-pull watermark to
    cut bandwidth."""
    # Watermark: max remote_updated_at we've ever recorded.
    with connect() as conn:
        row = conn.execute(
            "SELECT MAX(remote_updated_at) FROM sync_state WHERE remote_updated_at IS NOT NULL"
        ).fetchone()
    since = row[0] if row and row[0] else None

    # Pull each type separately so we can filter on the server and keep
    # responses small. Order: smart_tables first (fast, small), then
    # notes (potentially large).
    summary: dict[str, list[dict]] = {}
    for kind_filter in ("smart_table", "note", "wiki_topic"):
        params: dict = {"smartnote_type": kind_filter}
        if since:
            params["since"] = since
        try:
            r = _cloud_request("GET", "/v1/documents", params=params)
            r.raise_for_status()
        except Exception as e:
            summary[kind_filter] = [{"action": "error", "error": str(e)}]
            continue
        docs = r.json().get("documents") or []
        # /v1/documents list excludes content — fetch each full doc.
        kind_out: list[dict] = []
        for doc_brief in docs:
            try:
                full = _cloud_request("GET", f"/v1/documents/{doc_brief['id']}")
                full.raise_for_status()
                kind_out.append({
                    "doc_id": doc_brief["id"],
                    **_apply_remote(full.json()),
                })
            except Exception as e:
                kind_out.append({"doc_id": doc_brief.get("id"), "action": "error", "error": str(e)})
        summary[kind_filter] = kind_out
    return {"pulled": summary, "since": since}


def full_sync() -> dict:
    """Push then pull — single serial round. Rerun as needed; each
    pass converges further."""
    return {
        "push": push_all(),
        "pull": pull_all(),
        "finished_at": _now_iso(),
    }


def test_connection() -> dict:
    """Cheap 'is my API key valid?' probe. Returns workspace info on
    success, a structured error on failure."""
    try:
        url, _ = _ensure_configured()
    except Exception as e:
        return {"ok": False, "error": str(e)}
    try:
        r_health = httpx.get(f"{url}/v1/health", timeout=5.0)
        r_health.raise_for_status()
    except Exception as e:
        return {"ok": False, "error": f"cloud unreachable: {e}"}
    try:
        r = _cloud_request("GET", "/v1/me" if False else "/v1/usage")
        r.raise_for_status()
    except Exception as e:
        return {"ok": False, "error": f"api key rejected: {e}"}
    return {"ok": True, "workspace": r.json()}


def sync_status() -> dict:
    """Snapshot of sync_state for the Settings UI."""
    with connect() as conn:
        rows = conn.execute(
            "SELECT local_kind, COUNT(*) as n, MAX(last_pushed_at) as last_push, "
            "MAX(last_pulled_at) as last_pull FROM sync_state GROUP BY local_kind"
        ).fetchall()
        conflict_count = conn.execute(
            "SELECT COUNT(*) FROM sync_conflicts"
        ).fetchone()[0]
    enabled = bool(getattr(app_settings, "cloud_sync_enabled", False))
    url, key = _cfg()
    return {
        "enabled": enabled,
        "configured": bool(url and key),
        "cloud_url": url,
        "entities": [dict(zip(("local_kind", "count", "last_push", "last_pull"), r)) for r in rows],
        "conflicts": conflict_count,
    }
