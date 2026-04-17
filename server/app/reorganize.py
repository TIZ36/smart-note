"""Tag-based note reorganization.

Build a candidate reorganized markdown by grouping the raw file's content
under per-tag sections, using the existing `tag_segments` classifications.

Principles (from product-principles.md):
  - P0-1 single source of truth — we *rewrite* raw.md, but snapshot first
    so the reorganization is reversible (P0-2).
  - P0-4 incremental preferred — reorganization is opt-in, not automatic.
  - No content loss. Every line in the original file appears in the
    candidate exactly once. Lines that no tag_segment covers land in an
    "Unclassified" trailing section; nothing is silently dropped.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from app.db import connect


# Tag ordering preference — more "primary" tags first; falls back to
# alphabetical for custom tags the user has added.
_TAG_ORDER = [
    "work", "learn", "todo", "daily_life",
    "reminder", "hobby", "password", "others",
]


def build_candidate(raw_path: str) -> dict[str, Any]:
    """Return a reorganized markdown for `raw_path` plus accounting info.

    Result:
      {
        "raw_path": str,
        "before": str,              # original file content
        "candidate": str,            # reorganized markdown
        "line_count_before": int,
        "line_count_after": int,
        "tags_used": [str, ...],
        "unclassified_lines": int,
      }
    """
    p = Path(raw_path)
    if not p.exists():
        raise FileNotFoundError(f"raw_path does not exist: {raw_path}")

    before = p.read_text(encoding="utf-8")
    lines = before.splitlines()
    n_lines = len(lines)

    # Prefer the most recent *full* build for this file — full builds have
    # complete AI classification. Incremental builds may only have segments
    # for newly-added lines, making them unsuitable for whole-file reorganize.
    # Fall back to any build if no full build exists yet.
    with connect() as conn:
        build_row = conn.execute(
            "SELECT id FROM builds "
            "WHERE source_file = ? AND source_file NOT LIKE 'wiki:%' AND ingest_kind = 'full' "
            "ORDER BY is_active DESC, created_at DESC LIMIT 1",
            (raw_path,),
        ).fetchone()
        if not build_row:
            build_row = conn.execute(
                "SELECT id FROM builds "
                "WHERE source_file = ? AND source_file NOT LIKE 'wiki:%' "
                "ORDER BY is_active DESC, created_at DESC LIMIT 1",
                (raw_path,),
            ).fetchone()
        build_id = build_row["id"] if build_row else None

        if build_id:
            rows = conn.execute(
                "SELECT id, tag, topic_name, line_start, line_end, summary "
                "FROM tag_segments WHERE source_file = ? AND build_id = ? "
                "ORDER BY line_start ASC",
                (raw_path, build_id),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT id, tag, topic_name, line_start, line_end, summary "
                "FROM tag_segments WHERE source_file = ? "
                "ORDER BY line_start ASC",
                (raw_path,),
            ).fetchall()

    # Build owner map: line_no (1-based) → first-covering segment row (dict)
    # First-match-wins. Conflicts are resolved elsewhere (conflict_pending).
    owner: dict[int, dict] = {}
    for r in rows:
        for ln in range(r["line_start"], r["line_end"] + 1):
            if 1 <= ln <= n_lines and ln not in owner:
                owner[ln] = dict(r)

    # Group lines by tag while preserving original order within each tag.
    by_tag: dict[str, list[tuple[int, str]]] = {}
    unclassified: list[tuple[int, str]] = []
    for idx, content in enumerate(lines, start=1):
        seg = owner.get(idx)
        if seg:
            by_tag.setdefault(seg["tag"], []).append((idx, content))
        else:
            unclassified.append((idx, content))

    tags_used = sorted(by_tag.keys(), key=_tag_sort_key)

    parts: list[str] = []
    header_line = (
        f"<!-- Reorganized by tag · source: {p.name} · "
        f"{n_lines} lines across {len(tags_used)} tag(s) -->"
    )
    parts.append(header_line)
    parts.append("")

    for tag in tags_used:
        section_lines = by_tag[tag]
        if not section_lines:
            continue
        parts.append(f"## {tag}")
        parts.append("")
        for _, content in section_lines:
            parts.append(content)
        parts.append("")  # blank line between sections

    if unclassified:
        parts.append("## unclassified")
        parts.append("")
        for _, content in unclassified:
            parts.append(content)
        parts.append("")

    candidate = "\n".join(parts).rstrip() + "\n"

    # Accounting sanity check: no content lost. We treat whitespace-only
    # lines as compressible (section blanks may rearrange), so compare on
    # non-blank counts.
    nonblank_before = sum(1 for ln in lines if ln.strip())
    nonblank_after = sum(1 for ln in candidate.splitlines() if ln.strip())
    # The candidate adds 1 header comment + (1 heading + blank) per tag,
    # plus 1 heading for unclassified. Those are the only added non-blanks.
    added = 1 + len(tags_used) + (1 if unclassified else 0)
    expected = nonblank_before + added
    if nonblank_after != expected:
        # Surface as a warning in the response rather than erroring — the
        # UI can still show the diff for the user to judge.
        warning = (
            f"line-count check: nonblank before={nonblank_before} "
            f"after={nonblank_after} expected={expected} "
            f"(diff={nonblank_after - expected}) — review diff carefully"
        )
    else:
        warning = ""

    return {
        "raw_path": raw_path,
        "before": before,
        "candidate": candidate,
        "line_count_before": n_lines,
        "line_count_after": len(candidate.splitlines()),
        "tags_used": tags_used,
        "unclassified_lines": len(unclassified),
        "warning": warning,
    }


def _tag_sort_key(tag: str) -> tuple[int, str]:
    """Primary tags in `_TAG_ORDER` come first, custom tags alphabetical."""
    try:
        return (_TAG_ORDER.index(tag), tag)
    except ValueError:
        return (len(_TAG_ORDER), tag)
