"""Lossless raw file reorganization by topic.

Takes a messy raw file and reorganizes its content into structured,
topic-grouped markdown — without summarizing or removing any content.

The candidate is validated against the original through dual-search
comparison over a configurable period before the user can approve it.
"""

from __future__ import annotations

import json
import logging
import shutil
from datetime import datetime, timedelta
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor

import requests

from app.config import settings
from app.db import connect

logger = logging.getLogger(__name__)

MIN_QUERIES_FOR_APPROVAL = 20
DEFAULT_VALIDATION_DAYS = 7


# ── AI Rewrite ──────────────────────────────────────────────────

def _call_llm(system: str, user: str) -> str | None:
    if not getattr(settings, "ai_features_enabled", True):
        return None
    api_key = settings.provider_api_key
    if not api_key:
        return None
    model = getattr(settings, "ingest_ai_model", None) or settings.provider_chat_model
    base_url = settings.provider_base_url.rstrip("/")
    try:
        resp = requests.post(
            f"{base_url}/chat/completions",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json={
                "model": model,
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
                "temperature": 0.0,
                "max_tokens": 16000,
            },
            timeout=120,
        )
        resp.raise_for_status()
        return resp.json()["choices"][0]["message"]["content"]
    except Exception as e:
        logger.warning("Rewrite LLM call failed: %s", e)
        return None


REWRITE_SYSTEM = """You are a note organizer. Your job is to reorganize messy notes into clean, topic-grouped markdown.

RULES (CRITICAL):
1. LOSSLESS: Every single line from the input MUST appear in the output. Do NOT summarize, paraphrase, or omit anything.
2. GROUP BY TOPIC: Organize lines under topic headings (## Topic Name).
3. PRESERVE CONTENT: Keep the exact original text of each line. Only add markdown formatting (headings, bullets).
4. KEEP CREDENTIALS: API keys, tokens, passwords must be preserved exactly as-is.
5. USE SOURCE LANGUAGE: If notes are in Chinese, headings should be in Chinese.
6. OUTPUT ONLY THE REORGANIZED MARKDOWN, no explanations.

FORMAT:
## Topic Name
- original line 1
- original line 2

## Another Topic
- original line 3
"""


def generate_candidate(raw_path: str, note_path: str) -> dict:
    """Generate a reorganized candidate from the raw file.

    Processes in chunks to handle large files within LLM context limits.
    """
    raw_file = Path(raw_path)
    if not raw_file.exists():
        raise FileNotFoundError(f"Raw file not found: {raw_path}")

    content = raw_file.read_text(encoding="utf-8", errors="ignore")
    lines = [ln for ln in content.splitlines() if ln.strip()]

    if not lines:
        return {"status": "error", "message": "Raw file is empty"}

    # Process in chunks of ~200 lines to stay within context limits
    chunk_size = 200
    line_chunks = [lines[i:i + chunk_size] for i in range(0, len(lines), chunk_size)]

    # Process chunks concurrently
    chunk_results = []
    with ThreadPoolExecutor(max_workers=min(4, len(line_chunks))) as executor:
        futures = {
            executor.submit(_rewrite_chunk, chunk, idx): idx
            for idx, chunk in enumerate(line_chunks)
        }
        for future in futures:
            idx = futures[future]
            result = future.result()
            chunk_results.append((idx, result))

    chunk_results.sort(key=lambda x: x[0])

    # Merge chunk results — combine sections with same headings
    sections: dict[str, list[str]] = {}
    current_heading = "Uncategorized"
    for _, text in chunk_results:
        if not text:
            continue
        for line in text.splitlines():
            stripped = line.strip()
            if stripped.startswith("## "):
                current_heading = stripped[3:].strip()
                if current_heading not in sections:
                    sections[current_heading] = []
            elif stripped:
                if current_heading not in sections:
                    sections[current_heading] = []
                sections[current_heading].append(stripped)

    # Build final candidate markdown
    candidate_lines = []
    for heading, items in sections.items():
        candidate_lines.append(f"## {heading}")
        candidate_lines.append("")
        for item in items:
            if not item.startswith("- "):
                item = f"- {item}"
            candidate_lines.append(item)
        candidate_lines.append("")

    candidate_text = "\n".join(candidate_lines)

    # Verify lossless: count original lines vs candidate content lines
    original_count = len(lines)
    candidate_content_lines = [
        ln.lstrip("- ").strip()
        for ln in candidate_text.splitlines()
        if ln.strip() and not ln.startswith("## ")
    ]
    candidate_count = len(candidate_content_lines)

    # Save candidate file
    note_file = Path(note_path)
    candidate_dir = note_file.parent / "candidates"
    candidate_dir.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    candidate_path = candidate_dir / f"candidate_{timestamp}.md"
    candidate_path.write_text(candidate_text, encoding="utf-8")

    # Register in DB
    with connect() as conn:
        # Deactivate any existing validating candidates for this file
        conn.execute(
            "UPDATE rewrite_candidates SET status = 'superseded' WHERE source_file = ? AND status = 'validating'",
            (raw_path,),
        )
        conn.execute(
            """
            INSERT INTO rewrite_candidates(source_file, candidate_path, validation_days)
            VALUES (?, ?, ?)
            """,
            (raw_path, str(candidate_path), DEFAULT_VALIDATION_DAYS),
        )
        conn.commit()

    topics = list(sections.keys())

    return {
        "status": "ok",
        "candidate_path": str(candidate_path),
        "topics": topics,
        "original_lines": original_count,
        "candidate_lines": candidate_count,
        "coverage": round(candidate_count / max(original_count, 1) * 100, 1),
        "message": f"Candidate generated: {len(topics)} topics, {candidate_count}/{original_count} lines ({round(candidate_count / max(original_count, 1) * 100)}% coverage)",
    }


def _rewrite_chunk(lines: list[str], chunk_idx: int) -> str | None:
    """Rewrite a single chunk of lines via LLM."""
    text = "\n".join(lines)
    prompt = f"Reorganize these {len(lines)} notes by topic:\n\n{text}"
    return _call_llm(REWRITE_SYSTEM, prompt)


# ── Dual-search validation ──────────────────────────────────────

def record_validation(query: str, old_score: float, candidate_score: float) -> None:
    """Record a dual-search comparison for active candidates."""
    with connect() as conn:
        active = conn.execute(
            "SELECT id FROM rewrite_candidates WHERE status = 'validating'"
        ).fetchall()

        for row in active:
            cid = row["id"]
            winner = (
                "candidate" if candidate_score > old_score + 0.01
                else "old" if old_score > candidate_score + 0.01
                else "tie"
            )
            conn.execute(
                """
                INSERT INTO rewrite_validations(candidate_id, query_text, old_top5_score, candidate_top5_score, winner)
                VALUES (?, ?, ?, ?, ?)
                """,
                (cid, query, old_score, candidate_score, winner),
            )

            # Update aggregate counts
            if winner == "candidate":
                conn.execute("UPDATE rewrite_candidates SET candidate_wins = candidate_wins + 1, total_queries = total_queries + 1 WHERE id = ?", (cid,))
            elif winner == "old":
                conn.execute("UPDATE rewrite_candidates SET old_wins = old_wins + 1, total_queries = total_queries + 1 WHERE id = ?", (cid,))
            else:
                conn.execute("UPDATE rewrite_candidates SET ties = ties + 1, total_queries = total_queries + 1 WHERE id = ?", (cid,))

        conn.commit()


def get_candidate_status() -> dict | None:
    """Get the status of the active rewrite candidate."""
    with connect() as conn:
        row = conn.execute(
            """
            SELECT id, source_file, candidate_path, status, validation_start,
                   validation_days, total_queries, old_wins, candidate_wins, ties
            FROM rewrite_candidates
            WHERE status = 'validating'
            ORDER BY created_at DESC LIMIT 1
            """
        ).fetchone()

    if not row:
        return None

    start = datetime.fromisoformat(row["validation_start"])
    end = start + timedelta(days=row["validation_days"])
    now = datetime.now()
    days_elapsed = (now - start).days
    days_remaining = max(0, (end - now).days)

    total = row["total_queries"]
    cand_wins = row["candidate_wins"]
    old_wins = row["old_wins"]
    win_rate = round(cand_wins / max(total, 1) * 100, 1)

    # Check if ready for approval
    can_approve = (
        days_remaining == 0
        and total >= MIN_QUERIES_FOR_APPROVAL
        and cand_wins >= old_wins  # candidate at least as good
    )

    return {
        "id": row["id"],
        "source_file": row["source_file"],
        "candidate_path": row["candidate_path"],
        "status": row["status"],
        "days_elapsed": days_elapsed,
        "days_remaining": days_remaining,
        "total_queries": total,
        "candidate_wins": cand_wins,
        "old_wins": old_wins,
        "ties": row["ties"],
        "candidate_win_rate": win_rate,
        "can_approve": can_approve,
    }


def approve_candidate(candidate_id: int) -> dict:
    """Approve and apply the rewrite candidate — replaces the raw file."""
    with connect() as conn:
        row = conn.execute(
            "SELECT source_file, candidate_path, total_queries, candidate_wins, old_wins, validation_start, validation_days FROM rewrite_candidates WHERE id = ?",
            (candidate_id,),
        ).fetchone()

    if not row:
        raise ValueError("Candidate not found")

    # Verify approval conditions
    start = datetime.fromisoformat(row["validation_start"])
    end = start + timedelta(days=row["validation_days"])
    if datetime.now() < end:
        raise ValueError(f"Validation period not over ({(end - datetime.now()).days} days remaining)")
    if row["total_queries"] < MIN_QUERIES_FOR_APPROVAL:
        raise ValueError(f"Not enough queries ({row['total_queries']}/{MIN_QUERIES_FOR_APPROVAL})")
    if row["candidate_wins"] < row["old_wins"]:
        raise ValueError("Candidate has lower win rate than original")

    source = Path(row["source_file"])
    candidate = Path(row["candidate_path"])

    if not candidate.exists():
        raise FileNotFoundError("Candidate file missing")

    # Backup original
    backup = source.with_suffix(f".bak.{datetime.now().strftime('%Y%m%d_%H%M%S')}")
    shutil.copy2(source, backup)

    # Replace
    shutil.copy2(candidate, source)

    with connect() as conn:
        conn.execute(
            "UPDATE rewrite_candidates SET status = 'approved' WHERE id = ?",
            (candidate_id,),
        )
        conn.commit()

    return {
        "status": "approved",
        "backup": str(backup),
        "message": f"Raw file replaced. Original backed up to {backup.name}",
    }


def reject_candidate(candidate_id: int) -> dict:
    """Reject the rewrite candidate."""
    with connect() as conn:
        conn.execute(
            "UPDATE rewrite_candidates SET status = 'rejected' WHERE id = ?",
            (candidate_id,),
        )
        conn.commit()
    return {"status": "rejected"}
