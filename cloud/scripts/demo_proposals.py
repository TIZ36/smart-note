"""E2E: memory proposal queue.

Walks the full MLflow-autolog-style flow against a live cloud stack:
  1. Propose a preference ('reply in Chinese') — fresh, no similar.
  2. Propose an overlapping fact — gets flagged as similar to #1.
  3. List pending drafts, verify count.
  4. Accept #1 with an edit; accept #3 with supersedes=#1 (merge).
  5. Propose a noisy one, reject it.
  6. Verify: active count, archived count, draft count.

Mirrors how Claude Code / Cursor would trigger proposals during a
real conversation (propose first, then the user or next-turn agent
triages).
"""

from __future__ import annotations

import os
import sys
import time
from pathlib import Path

import httpx

HERE = Path(__file__).resolve()
sys.path.insert(0, str(HERE.parents[1] / "sdk-py"))

from smartnote_cloud import Client, SmartNoteError  # noqa: E402

BASE = os.getenv("BASE", "http://localhost:58000")


def bootstrap_key() -> str:
    r = httpx.post(
        f"{BASE}/v1/dev/bootstrap",
        json={
            "tenant_name": "proposals-demo",
            "workspace_name": "default",
            "workspace_slug": f"proposals-{int(time.time())}",
            "api_key_name": "proposals-demo",
        },
        timeout=10.0,
    )
    r.raise_for_status()
    return r.json()["api_key"]["secret"]


def main() -> int:
    print(f"→ cloud at {BASE}")
    key = bootstrap_key()
    print(f"✓ workspace minted: {key[:30]}…")

    with Client(api_key=key, base_url=BASE) as sn:
        print("\n── 1. propose: fresh preference")
        p1 = sn.proposals.propose(
            kind="preference",
            content="reply in Chinese unless asked otherwise",
            reason="user wrote messages in Chinese; inferred from 3 turns",
        )
        print(f"  id={p1['id']} similar={len(p1.get('similar_existing', []))}")
        assert len(p1.get("similar_existing", [])) == 0, "fresh proposal shouldn't match anything"

        print("\n── 2. propose: similar content (should trigger dedup hint)")
        # Accept the first one so it's active and can match similarity.
        sn.proposals.accept(p1["id"])
        p2 = sn.proposals.propose(
            kind="preference",
            content="please respond in Chinese by default",
            reason="user said so again",
        )
        print(f"  id={p2['id']} similar={len(p2.get('similar_existing', []))}")
        assert p2.get("similar_existing"), "near-duplicate should be flagged"
        hint = p2["similar_existing"][0]
        print(f"  ↪ hint: {hint['similarity']:.2f} — '{hint['content'][:60]}'")

        print("\n── 3. propose: a noisy one we'll reject")
        p3 = sn.proposals.propose(
            kind="episode",
            content="user mentioned the weather is nice today",
            reason="might be useful context later?",
        )
        print(f"  id={p3['id']}")

        print("\n── 4. list drafts")
        queue = sn.proposals.list()
        print(f"  {queue['total']} in queue")
        for p in queue["proposals"]:
            print(f"    [{p['kind']}, conf={p['confidence']:.2f}] {p['content'][:60]}")
        assert queue["total"] == 2, f"expected 2 drafts, got {queue['total']}"

        print("\n── 5a. accept the dedup one with supersedes=p1 (merge)")
        r = sn.proposals.accept(p2["id"], supersedes=hint["id"])
        print(f"  status={r['status']} supersedes={r.get('supersedes')}")
        assert r["status"] == "active"
        assert r["supersedes"] == hint["id"]

        print("\n── 5b. reject the noisy one")
        r = sn.proposals.reject(p3["id"], reason="weather is not a useful memory signal")
        print(f"  status={r['status']}")
        assert r["status"] == "archived"

        print("\n── 6. verify final state")
        active_all = sn.memories.list(kind="preference")
        print(f"  active preferences: {len(active_all)}")
        drafts = sn.proposals.list()
        print(f"  remaining drafts:   {drafts['total']}")
        assert drafts["total"] == 0
        # Should have: 2 preference rows (original + merged supersede)
        # plus 1 archived episode — the archived one is hidden by
        # retrieve's default status filter.
        r = sn.retrieve("language preference", topk=5)
        print(f"  retrieve hits: {len(r['results'])}")

    print("\n🎉 proposal queue E2E passed")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SmartNoteError as e:
        print(f"\n❌ SmartNote API error (status={e.status}): {e}")
        if e.body:
            print(f"   body: {e.body}")
        sys.exit(1)
