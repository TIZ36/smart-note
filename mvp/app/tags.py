"""Tag-based content classification.

User-manageable tags stored in a JSON config file.
Supports add, delete, reorder. System defaults are seeds.
"""

from __future__ import annotations

import json
from pathlib import Path

from app.config import settings

# macOS-style tag colors
TAG_COLORS = ["red", "orange", "yellow", "green", "blue", "purple", "gray"]

SYSTEM_TAGS = [
    {"name": "learn", "desc": "Study notes, tutorials, knowledge, reading notes, technical learning", "color": "blue"},
    {"name": "work", "desc": "Work tasks, meetings, projects, requirements, bugs, deployment", "color": "green"},
    {"name": "todo", "desc": "Action items, follow-ups, checklists, deadlines, pending tasks", "color": "red"},
    {"name": "daily_life", "desc": "Personal life, health, finance, shopping, travel, family", "color": "orange"},
    {"name": "password", "desc": "API keys, tokens, passwords, secrets, credentials, certificates", "color": "yellow"},
    {"name": "reminder", "desc": "Reminders, alerts, scheduled events, important dates", "color": "purple"},
    {"name": "hobby", "desc": "Hobbies, entertainment, games, music, movies, sports, side projects", "color": "green"},
    {"name": "others", "desc": "Anything that doesn't fit the above categories", "color": "gray"},
]


def _tags_file() -> Path:
    return Path(settings.db_path).parent / "tags.json"


def _load_tags() -> list[dict]:
    """Load tag config from file. Seeds with defaults if missing."""
    f = _tags_file()
    if f.exists():
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
            if isinstance(data, list) and len(data) > 0:
                return data
        except (json.JSONDecodeError, TypeError):
            pass
    # Seed with system defaults
    _save_tags(SYSTEM_TAGS)
    return list(SYSTEM_TAGS)


def _save_tags(tags: list[dict]) -> None:
    f = _tags_file()
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(json.dumps(tags, ensure_ascii=False, indent=2), encoding="utf-8")


def get_all_tags() -> list[str]:
    return [t["name"] for t in _load_tags()]


def get_tags_with_desc() -> list[dict]:
    return _load_tags()


def add_tag(name: str, desc: str = "", color: str = "gray") -> list[dict]:
    """Add a new tag. Auto-generates desc from name if not provided."""
    tags = _load_tags()
    if any(t["name"] == name for t in tags):
        return tags
    if not desc:
        desc = f"Notes related to {name.replace('_', ' ')}"
    if color not in TAG_COLORS:
        color = "gray"
    tags.append({"name": name, "desc": desc, "color": color})
    _save_tags(tags)
    return tags


def delete_tag(name: str) -> list[dict]:
    """Delete a tag. Returns updated tag list."""
    tags = _load_tags()
    tags = [t for t in tags if t["name"] != name]
    if not tags:
        tags = [{"name": "others", "desc": "Uncategorized"}]
    _save_tags(tags)
    return tags


def reorder_tags(ordered_names: list[str]) -> list[dict]:
    """Reorder tags by name list. Returns updated tag list."""
    tags = _load_tags()
    tag_map = {t["name"]: t for t in tags}
    reordered = []
    for name in ordered_names:
        if name in tag_map:
            reordered.append(tag_map.pop(name))
    # Append any remaining that weren't in the order list
    for t in tag_map.values():
        reordered.append(t)
    _save_tags(reordered)
    return reordered


def set_tag_color(name: str, color: str) -> list[dict]:
    """Set a tag's color. Returns updated tag list."""
    if color not in TAG_COLORS:
        color = "gray"
    tags = _load_tags()
    for t in tags:
        if t["name"] == name:
            t["color"] = color
            break
    _save_tags(tags)
    return tags


def get_tag_list_for_prompt() -> str:
    """Build the tag list description for the AI prompt."""
    tags = _load_tags()
    lines = []
    for t in tags:
        lines.append(f'  - "{t["name"]}": {t.get("desc", "")}')
    return "\n".join(lines)
