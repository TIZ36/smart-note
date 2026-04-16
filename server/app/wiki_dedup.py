"""Wiki source de-duplication.

Detects .md/.txt files under `wiki_sources_dir` that aren't referenced by
any chunk in the DB — "orphan" files that drift into the iCloud folder as
users re-import under new names without cleaning up the old drafts.

Classifies each orphan against the existing imported topics:

  - ``identical``  — byte-level sha256 match → safe to delete
  - ``near_dup``   — normalized-text match >= 0.95 → safe to delete
  - ``subset``     — orphan's lines are almost all present in an imported
                      topic (>= 0.85 containment) → likely an earlier draft
                      whose content has been fully absorbed → delete
  - ``similar``    — semantic similarity 0.7-0.95, but not containment →
                      review manually; may be a divergent version worth keeping
  - ``distinct``   — no strong match → candidate for import

The caller decides what to do. ``apply_dedup_actions`` executes chosen
actions (delete / keep / import) with dry-run support.
"""

from __future__ import annotations

import difflib
import hashlib
import re
from pathlib import Path

from app.config import settings
from app.db import connect


_BULLET_RE = re.compile(r"^[-*+]\s+|^\d+\.\s+|^#+\s+")
_WS_RE = re.compile(r"\s+")


def _normalize(text: str) -> str:
    """Collapse formatting noise (bullets, heading markers, extra whitespace)
    to a line-per-line canonical form. Case-insensitive."""
    out: list[str] = []
    for raw in text.splitlines():
        s = raw.strip()
        if not s:
            continue
        s = _BULLET_RE.sub("", s)
        s = _WS_RE.sub(" ", s)
        out.append(s.lower())
    return "\n".join(out)


def _file_sha(path: Path) -> str:
    try:
        return hashlib.sha256(path.read_bytes()).hexdigest()[:16]
    except Exception:
        return ""


def _resolve_topic_md(source_file: str) -> Path | None:
    """tag_segments.source_file may point at a folder (pre-flatten) or the
    .md directly (post-flatten). Return a real .md path or None."""
    if not source_file:
        return None
    p = Path(source_file)
    if p.is_file() and p.suffix.lower() in (".md", ".txt"):
        return p
    if p.is_dir():
        mds = sorted(p.rglob("*.md"))
        if mds:
            return mds[0]
        txts = sorted(p.rglob("*.txt"))
        if txts:
            return txts[0]
    return None


def scan_orphans() -> list[Path]:
    """Walk wiki_sources_dir and return every .md/.txt file that isn't
    referenced by any chunk in the DB."""
    src_root = Path(settings.wiki_sources_dir)
    if not src_root.exists():
        return []

    with connect() as conn:
        known_chunk_sources = {
            (r["source_file"] or "") for r in conn.execute(
                "SELECT DISTINCT source_file FROM chunks "
                "WHERE dimension LIKE 'wiki:%' AND source_file IS NOT NULL"
            ).fetchall()
        }

    orphans: list[Path] = []
    for p in src_root.rglob("*"):
        if not p.is_file():
            continue
        if p.name.startswith("."):
            continue
        if p.suffix.lower() not in (".md", ".txt"):
            continue
        if str(p) in known_chunk_sources:
            continue
        orphans.append(p)
    orphans.sort()
    return orphans


def classify_orphan(orphan: Path, imported: list[dict]) -> dict:
    """Compare one orphan file against every imported topic and return the
    best match with a suggested action."""
    try:
        orphan_text = orphan.read_text(encoding="utf-8", errors="ignore")
    except Exception as e:
        return {
            "path": str(orphan),
            "error": str(e),
            "suggested_action": "skip",
        }

    orphan_sha = _file_sha(orphan)
    orphan_norm = _normalize(orphan_text)
    orphan_lines = set(orphan_norm.splitlines())
    orphan_size = orphan.stat().st_size

    best: dict | None = None
    for imp in imported:
        imp_md = _resolve_topic_md(imp.get("source_file", ""))
        if not imp_md or not imp_md.exists():
            continue
        imp_sha = _file_sha(imp_md)
        if orphan_sha and imp_sha and orphan_sha == imp_sha:
            return {
                "path": str(orphan),
                "size": orphan_size,
                "match_topic": imp["topic_name"],
                "match_path": str(imp_md),
                "match_type": "identical",
                "similarity": 1.0,
                "containment": 1.0,
                "suggested_action": "delete",
            }
        try:
            imp_text = imp_md.read_text(encoding="utf-8", errors="ignore")
        except Exception:
            continue
        imp_norm = _normalize(imp_text)
        imp_lines = set(imp_norm.splitlines())
        if not orphan_lines or not imp_lines:
            continue
        containment = len(orphan_lines & imp_lines) / len(orphan_lines)
        # SequenceMatcher is expensive; cap at ~50K chars each side.
        if len(orphan_norm) < 50_000 and len(imp_norm) < 50_000:
            ratio = difflib.SequenceMatcher(None, orphan_norm, imp_norm).quick_ratio()
        else:
            ratio = 0.0
        score = max(containment, ratio)
        if best is None or score > best["score"]:
            best = {
                "topic_name": imp["topic_name"],
                "path": str(imp_md),
                "containment": round(containment, 3),
                "ratio": round(ratio, 3),
                "score": score,
            }

    if best is None:
        return {
            "path": str(orphan),
            "size": orphan_size,
            "match_type": "no_baseline",
            "suggested_action": "import",
        }

    if best["score"] >= 0.95:
        match_type = "near_dup"
        action = "delete"
    elif best["containment"] >= 0.85:
        match_type = "subset"
        action = "delete"
    elif best["score"] >= 0.7:
        match_type = "similar"
        action = "review"
    else:
        match_type = "distinct"
        action = "import"

    return {
        "path": str(orphan),
        "size": orphan_size,
        "match_topic": best["topic_name"],
        "match_path": best["path"],
        "match_type": match_type,
        "similarity": round(best["score"], 3),
        "containment": best["containment"],
        "suggested_action": action,
    }


def find_duplicate_wiki_sources() -> list[dict]:
    """Entry point for `GET /wiki/duplicates`: scan + classify."""
    orphans = scan_orphans()
    if not orphans:
        return []
    with connect() as conn:
        rows = conn.execute(
            "SELECT topic_name, source_file FROM tag_segments "
            "WHERE tag LIKE 'wiki:%'"
        ).fetchall()
    imported = [
        {"topic_name": r["topic_name"], "source_file": r["source_file"]}
        for r in rows if r["topic_name"]
    ]
    return [classify_orphan(o, imported) for o in orphans]


def cleanup_hints(max_items: int = 20) -> list[dict]:
    """Cheaper variant for piggybacking on other endpoints (e.g.
    wiki_reorganize's response). Returns only entries whose
    suggested_action is 'delete' — the unambiguous cases — so the
    caller sees a short, actionable list."""
    all_candidates = find_duplicate_wiki_sources()
    return [c for c in all_candidates
            if c.get("suggested_action") == "delete"][:max_items]


def apply_dedup_actions(actions: list[dict], dry_run: bool = True) -> dict:
    """Execute a list of {path, action, ...} entries.

    Supported actions:
      - 'delete'  — unlink the file; remove the parent dir if it empties out
      - 'keep'    — no-op (explicitly acknowledge, keeps an audit trail)
      - 'import'  — move the orphan into its own topic folder under
                    wiki_sources_dir and ingest it as a wiki topic. Optional
                    `topic_name` in the action dict overrides the default
                    (orphan filename stem).
    """
    applied: list[dict] = []
    errors: list[dict] = []
    skipped: list[dict] = []
    for act in actions or []:
        path = (act.get("path") or "").strip()
        action = (act.get("action") or "").strip().lower()
        if not path or not action:
            errors.append({**act, "error": "missing path/action"})
            continue
        p = Path(path)
        if action != "keep" and not p.exists():
            skipped.append({**act, "reason": "file missing"})
            continue

        if action == "delete":
            if dry_run:
                applied.append({**act, "would": "delete"})
                continue
            try:
                parent = p.parent
                p.unlink()
                # Clean up any now-empty parent dirs (up to wiki_sources_dir).
                src_root = Path(settings.wiki_sources_dir).resolve()
                d = parent
                while d != d.parent and d != src_root:
                    try:
                        d.rmdir()
                    except OSError:
                        break
                    d = d.parent
                applied.append(act)
            except Exception as e:
                errors.append({**act, "error": str(e)})

        elif action == "keep":
            applied.append({**act, "noted": "kept"})

        elif action == "import":
            topic_name = (act.get("topic_name") or "").strip() or p.stem
            src_root = Path(settings.wiki_sources_dir).resolve()
            # Target: wiki_sources_dir/<topic>/<filename>. If the orphan is
            # already the only file in its own topic folder, reuse that folder
            # in-place — avoids pointless filesystem churn.
            try:
                already_own_folder = (
                    p.parent != src_root
                    and p.parent.parent == src_root
                    and sum(1 for f in p.parent.iterdir() if f.is_file()) == 1
                )
            except OSError:
                already_own_folder = False

            if already_own_folder:
                topic_folder = p.parent
                final_path = p
            else:
                safe_topic = re.sub(r'[^\w\s\u4e00-\u9fff-]', '_', topic_name)[:80] or p.stem
                topic_folder = src_root / safe_topic
                final_path = topic_folder / p.name

            if dry_run:
                applied.append({
                    **act,
                    "would": "import",
                    "topic_name": topic_name,
                    "target": str(final_path),
                })
                continue
            try:
                if not already_own_folder:
                    topic_folder.mkdir(parents=True, exist_ok=True)
                    if final_path.exists() and final_path.resolve() != p.resolve():
                        # Don't clobber an existing file — append a suffix.
                        i = 1
                        while True:
                            alt = topic_folder / f"{p.stem}_{i}{p.suffix}"
                            if not alt.exists():
                                final_path = alt
                                break
                            i += 1
                    p.rename(final_path)
                # Ingest the topic folder. Deferred import keeps wiki_dedup
                # importable in contexts where special_ingest isn't loaded.
                from app.special_ingest import ingest_folder
                result = ingest_folder(
                    str(topic_folder),
                    topic_name=topic_name,
                    ai_delegate=bool(act.get("ai_delegate", False)),
                )
                applied.append({
                    **act,
                    "imported": True,
                    "topic_name": topic_name,
                    "final_path": str(final_path),
                    "chunk_count": result.get("chunk_count"),
                    "segment_count": result.get("segment_count"),
                })
            except Exception as e:
                errors.append({**act, "error": f"import failed: {e}"})

        else:
            errors.append({**act, "error": f"unknown action: {action}"})

    return {
        "dry_run": dry_run,
        "applied": applied,
        "errors": errors,
        "skipped": skipped,
    }
