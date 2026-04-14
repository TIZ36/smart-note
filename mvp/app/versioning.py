"""Knowledge base version management.

Snapshots the DB and view files before rebuilds, keeps up to 10 versions,
allows listing and restoring previous versions.
"""

from __future__ import annotations

import json
import os
import shutil
from datetime import datetime
from pathlib import Path

from app.config import settings

MAX_VERSIONS = 10


def _versions_dir() -> Path:
    """Get the versions directory (sibling to the DB file)."""
    db_dir = Path(settings.db_path).parent
    return db_dir / "versions"


def list_versions() -> list[dict]:
    """List all available versions, newest first."""
    vdir = _versions_dir()
    if not vdir.exists():
        return []

    versions = []
    for d in sorted(vdir.iterdir(), reverse=True):
        if d.is_dir():
            meta_path = d / "meta.json"
            if meta_path.exists():
                meta = json.loads(meta_path.read_text(encoding="utf-8"))
                meta["path"] = str(d)
                versions.append(meta)
    return versions


def create_snapshot(note_path: str, reason: str = "rebuild", extra_meta: dict | None = None) -> dict:
    """Create a versioned snapshot of the current DB + views.

    Returns the snapshot metadata.
    """
    vdir = _versions_dir()
    vdir.mkdir(parents=True, exist_ok=True)

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    snap_dir = vdir / f"v_{timestamp}"
    snap_dir.mkdir(parents=True, exist_ok=True)

    # Copy database
    db_path = Path(settings.db_path)
    if db_path.exists():
        shutil.copy2(db_path, snap_dir / "app.db")

    # Copy views directory
    if note_path:
        views_dir = Path(note_path).parent / "views"
        if views_dir.exists():
            shutil.copytree(views_dir, snap_dir / "views", dirs_exist_ok=True)

        # Copy note file
        note_file = Path(note_path)
        if note_file.exists():
            shutil.copy2(note_file, snap_dir / "note.md")

        # Copy state file
        state_file = Path(note_path).parent / ".state.json"
        if state_file.exists():
            shutil.copy2(state_file, snap_dir / ".state.json")

    # Count chunks for metadata
    chunk_count = 0
    try:
        import sqlite3
        conn = sqlite3.connect(str(db_path))
        chunk_count = conn.execute("SELECT COUNT(1) FROM chunks").fetchone()[0]
        conn.close()
    except Exception:
        pass

    meta = {
        "version": timestamp,
        "reason": reason,
        "created_at": datetime.now().isoformat(),
        "chunk_count": chunk_count,
    }
    if extra_meta:
        meta.update(extra_meta)
    (snap_dir / "meta.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    # Prune old versions (keep MAX_VERSIONS)
    _prune_old_versions()

    return meta


def restore_version(version_id: str, note_path: str) -> dict:
    """Restore a previous version of the knowledge base."""
    vdir = _versions_dir()
    snap_dir = vdir / f"v_{version_id}"
    if not snap_dir.exists():
        raise FileNotFoundError(f"Version {version_id} not found")

    # Create a snapshot of current state before restoring
    create_snapshot(note_path, reason=f"pre-restore-{version_id}")

    # Restore database
    db_backup = snap_dir / "app.db"
    if db_backup.exists():
        db_path = Path(settings.db_path)
        shutil.copy2(db_backup, db_path)

    if note_path:
        # Restore views
        views_backup = snap_dir / "views"
        views_dir = Path(note_path).parent / "views"
        if views_backup.exists():
            if views_dir.exists():
                shutil.rmtree(views_dir)
            shutil.copytree(views_backup, views_dir)

        # Restore note file
        note_backup = snap_dir / "note.md"
        if note_backup.exists():
            shutil.copy2(note_backup, Path(note_path))

        # Restore state file
        state_backup = snap_dir / ".state.json"
        state_file = Path(note_path).parent / ".state.json"
        if state_backup.exists():
            shutil.copy2(state_backup, state_file)

    meta = json.loads((snap_dir / "meta.json").read_text(encoding="utf-8"))
    return {"restored": version_id, "chunk_count": meta.get("chunk_count", 0)}


def delete_version(version_id: str) -> dict:
    """Delete a specific version snapshot."""
    vdir = _versions_dir()
    snap_dir = vdir / f"v_{version_id}"
    if not snap_dir.exists():
        raise FileNotFoundError(f"Version {version_id} not found")
    shutil.rmtree(snap_dir)
    return {"deleted": version_id}


def _prune_old_versions():
    """Keep only the latest MAX_VERSIONS snapshots."""
    vdir = _versions_dir()
    if not vdir.exists():
        return
    dirs = sorted(
        [d for d in vdir.iterdir() if d.is_dir()], key=lambda d: d.name
    )
    while len(dirs) > MAX_VERSIONS:
        oldest = dirs.pop(0)
        shutil.rmtree(oldest)
