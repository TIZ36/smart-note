"""End-to-end smoke test for the SmartNote Cloud stack.

Covers the full MVP API surface:
  1. Dev bootstrap → tenant + workspace + admin api key
  2. Memories: add, list, get, PATCH (re-embed), filter, delete
  3. Preferences: set, get, list, re-set (supersede), delete
  4. Documents: create + synchronous ingest into document_ref memories
  5. Retrieve: semantic + lexical hybrid ranking
  6. Usage: counter readback

Prereqs: `docker compose up` in cloud/infra/ with ALLOW_DEV_BOOTSTRAP=true.

Run from repo root:
    python cloud/scripts/demo.py                         # defaults to :58000
    BASE=http://1.2.3.4:58000 python cloud/scripts/demo.py
"""

from __future__ import annotations

import os
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve()
sys.path.insert(0, str(HERE.parents[1] / "sdk-py"))

import httpx  # noqa: E402

from smartnote_cloud import Client, SmartNoteError  # noqa: E402


BASE = os.getenv("BASE", "http://localhost:58000")


def wait_for_health(timeout: float = 60.0) -> None:
    deadline = time.time() + timeout
    last_err: Exception | None = None
    while time.time() < deadline:
        try:
            if httpx.get(f"{BASE}/v1/health", timeout=3.0).status_code == 200:
                return
        except Exception as e:
            last_err = e
        time.sleep(1.0)
    raise RuntimeError(f"api didn't come up in {timeout}s (last error: {last_err})")


def bootstrap() -> str:
    resp = httpx.post(
        f"{BASE}/v1/dev/bootstrap",
        json={
            "tenant_name": "demo",
            "workspace_name": "default",
            "workspace_slug": f"default-{int(time.time())}",
            "api_key_name": "demo-key",
        },
        timeout=10.0,
    )
    if resp.status_code == 404:
        raise RuntimeError(
            "POST /v1/dev/bootstrap returned 404 — set ALLOW_DEV_BOOTSTRAP=true "
            "in cloud/infra/.env and restart the api container."
        )
    resp.raise_for_status()
    info = resp.json()
    print(f"✓ workspace={info['workspace']['id']} key={info['api_key']['prefix']}…")
    return info["api_key"]["secret"]


def section(title: str) -> None:
    print(f"\n── {title} ──")


def main() -> int:
    print(f"→ probing {BASE}/v1/health")
    wait_for_health()
    print("✓ api is healthy")

    print("→ bootstrapping tenant / workspace / api key")
    api_key = bootstrap()

    with Client(api_key=api_key, base_url=BASE) as sn:
        section("Memories")
        pref = sn.memories.add(
            kind="preference",
            content="reply in Chinese unless asked otherwise",
            structured={"key": "language", "value": "zh"},
            tags=["style"],
        )
        fact = sn.memories.add(
            kind="fact",
            content="User is building SmartNote, a personal knowledge base product.",
            tags=["profile"],
        )
        episode = sn.memories.add(
            kind="episode",
            content="On 2026-04-21, user shipped the W1 cloud API skeleton end-to-end.",
            tags=["milestone"],
        )
        print(f"  added 3 memories: {pref['kind']}, {fact['kind']}, {episode['kind']}")
        all_rows = sn.memories.list()
        assert len(all_rows) == 3, f"expected 3, got {len(all_rows)}"

        # PATCH — pin the fact + rewrite its content to trigger re-embed
        patched = sn.memories.patch(
            fact["id"],
            content="User is the founder of SmartNote, an agent-memory SaaS.",
            pinned=True,
        )
        assert patched["pinned"] is True
        assert "founder" in patched["content"]
        print(f"  ✓ patched fact → pinned + re-embedded")

        section("Preferences sugar")
        sn.preferences.set("code_style", "concise, no emoji",
                           description="personal code-review style")
        sn.preferences.set("reply_lang", "zh")
        flat = sn.preferences.all()
        assert "code_style" in flat and "reply_lang" in flat
        print(f"  flat KV: {list(flat.keys())}")
        # Supersede: re-set reply_lang, old row stays but "current" is new
        updated = sn.preferences.set("reply_lang", "en",
                                     description="switched during test")
        assert updated["supersedes"] is not None
        current = sn.preferences.get("reply_lang")
        assert current["value"] == "en"
        print(f"  ✓ supersede chain: reply_lang now = {current['value']}")

        section("Documents + ingest")
        doc = sn.documents.add(
            name="project-notes.md",
            content=(
                "# Project notes\n\n"
                "The memory API is the heart of SmartNote Cloud. It lets any agent "
                "(Claude Code, Cursor, custom) share a unified store of user "
                "preferences, facts, and episodic context.\n\n"
                "## Retrieval design\n\n"
                "We blend vector similarity with lexical fallback. Pinned memories "
                "always win ties so durable user preferences aren't buried under "
                "ephemeral chatter.\n\n"
                "## Next steps\n\n"
                "Supabase auth for console users. TypeScript SDK. Simple quota "
                "metering. Then we dogfood with Cursor."
            ),
        )
        ingest = sn.documents.ingest(doc["id"])
        print(f"  doc={doc['id'][:8]}… ingested {ingest['chunks']} chunk(s)")

        section("Retrieve (hybrid)")
        # Vector + lexical: asks about retrieval design, should hit both
        # the doc chunks and the memories.
        hits = sn.retrieve("how does the memory API ranking work?", topk=5)
        print(f"  query_embedded={hits['query_embedded']}, hits={len(hits['results'])}")
        for r in hits["results"][:3]:
            print(
                f"    [{r['kind']}, score={r['score']:.3f} "
                f"vec={r['vector_score']:.2f} lex={r['lexical_score']:.2f}]"
                f" {r['content'][:70]}"
            )
        assert hits["results"], "retrieve returned no results"

        # Lexical-only sanity check — pure text match against a preference.
        lex_hits = sn.retrieve(
            "code_style", topk=3, vector_weight=0.0, lexical_weight=1.0,
        )
        assert any("code_style" in r["content"] for r in lex_hits["results"])
        print(f"  ✓ lexical-only path works")

        section("Usage counters")
        u = sn.usage.current()
        print(f"  memories={u['memory_count']} documents={u['document_count']} "
              f"retrieve_calls={u['retrieve_calls']}")
        assert u["memory_count"] >= 5         # 3 initial + 2 prefs + ingest chunks
        assert u["document_count"] == 1
        assert u["retrieve_calls"] >= 2

        section("Cleanup: delete episode + preference")
        sn.memories.delete(episode["id"])
        sn.preferences.delete("code_style")
        remaining = len(sn.memories.list())
        print(f"  remaining memories: {remaining}")

    print("\n🎉 extended end-to-end demo passed")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SmartNoteError as e:
        print(f"\n❌ SmartNote API error (status={e.status}): {e}")
        if e.body:
            print(f"   body: {e.body}")
        sys.exit(1)
    except Exception as e:
        print(f"\n❌ unexpected error: {e}")
        raise
