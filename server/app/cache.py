"""Answer cache (A3) + in-memory TTL cache for MCP tool results (E1).

Answer cache:
- Signature = sha256(query_text_normalized + sorted evidence_ids).
- Only stored when top evidence has aggregate trust_score >= TRUST_FLOOR.
- Read: signature match → serve cached answer_text; bump hit_count.
- Invalidated on: trust_score drop below floor, evidence chunks deleted/edited.

TTL cache:
- Plain dict with (key → (value, expiry_ts)). Single-process, good enough for
  an MCP proxy running alongside the gateway.
"""

from __future__ import annotations

import hashlib
import json
import threading
import time

from app.db import connect


TRUST_FLOOR = 1.0  # minimum aggregate evidence trust to cache


def _signature(query_text: str, evidence_ids: list[int]) -> str:
    norm = (query_text or "").strip().lower()
    ids = sorted(int(x) for x in evidence_ids if isinstance(x, int))
    raw = f"{norm}||{','.join(str(i) for i in ids)}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:32]


def lookup_answer(query_text: str, evidence_ids: list[int]) -> dict | None:
    sig = _signature(query_text, evidence_ids)
    with connect() as conn:
        r = conn.execute(
            "SELECT id, answer_text, model_name, hit_count FROM answer_cache "
            "WHERE signature = ?",
            (sig,),
        ).fetchone()
        if not r:
            return None
        conn.execute(
            "UPDATE answer_cache SET hit_count = hit_count + 1 WHERE id = ?",
            (r["id"],),
        )
        conn.commit()
        return {
            "answer": r["answer_text"],
            "model": r["model_name"],
            "hit_count": int(r["hit_count"]) + 1,
            "cached": True,
        }


def save_answer(
    query_text: str,
    evidence_ids: list[int],
    answer_text: str,
    model_name: str,
    evidence_trust_sum: float,
) -> bool:
    if evidence_trust_sum < TRUST_FLOOR:
        return False  # don't cache low-trust answers
    sig = _signature(query_text, evidence_ids)
    with connect() as conn:
        try:
            conn.execute(
                "INSERT OR IGNORE INTO answer_cache("
                "signature, query_text, evidence_ids_json, answer_text, "
                "model_name, trust_floor) VALUES (?, ?, ?, ?, ?, ?)",
                (
                    sig, query_text,
                    json.dumps(evidence_ids, ensure_ascii=False),
                    answer_text, model_name, evidence_trust_sum,
                ),
            )
            conn.commit()
            return True
        except Exception:
            return False


def invalidate_chunks(chunk_ids: list[int]) -> int:
    """Drop any cache entries whose evidence contains any of the given ids.
    Called when chunks are deleted/edited (ingest edit detection path)."""
    if not chunk_ids:
        return 0
    removed = 0
    with connect() as conn:
        rows = conn.execute("SELECT id, evidence_ids_json FROM answer_cache").fetchall()
        for r in rows:
            try:
                ev = json.loads(r["evidence_ids_json"] or "[]")
            except Exception:
                continue
            if any(cid in ev for cid in chunk_ids):
                conn.execute("DELETE FROM answer_cache WHERE id = ?", (r["id"],))
                removed += 1
        conn.commit()
    return removed


# ── TTL cache for MCP proxy (E1) ──

class TTLCache:
    """Very small in-memory TTL cache. Suitable for MCP tool-result dedup
    within a single gateway process. Not suitable for multi-instance setups."""

    def __init__(self, default_ttl: float = 300.0):
        self._store: dict[str, tuple[object, float]] = {}
        self._lock = threading.Lock()
        self.default_ttl = default_ttl

    def get(self, key: str):
        with self._lock:
            v = self._store.get(key)
            if not v:
                return None
            value, expiry = v
            if time.time() > expiry:
                del self._store[key]
                return None
            return value

    def set(self, key: str, value, ttl: float | None = None) -> None:
        exp = time.time() + (ttl if ttl is not None else self.default_ttl)
        with self._lock:
            self._store[key] = (value, exp)

    def clear(self) -> None:
        with self._lock:
            self._store.clear()

    def stats(self) -> dict:
        with self._lock:
            now = time.time()
            alive = sum(1 for _, (_, exp) in self._store.items() if exp > now)
            return {"alive": alive, "total": len(self._store)}


# Singleton used by mcp_server
tool_result_cache = TTLCache(default_ttl=300.0)
