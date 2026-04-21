"""End-to-end smoke test for the SmartNote Cloud stack.

What it does:
  1. POST /v1/dev/bootstrap → create tenant + workspace + admin api key
  2. Instantiate the Python SDK with the minted api key
  3. Add two memories (one preference, one fact)
  4. List them back + fetch by id
  5. Delete one, verify the other remains

Prereqs: `docker compose up` in cloud/infra/ (or equivalent) with
ALLOW_DEV_BOOTSTRAP=true.

Run from repo root:
    python cloud/scripts/demo.py                         # defaults to :8000
    BASE=http://1.2.3.4:8000 python cloud/scripts/demo.py
"""

from __future__ import annotations

import os
import sys
import time
from pathlib import Path

# Add the sibling SDK to sys.path so the demo works straight out of the
# repo without an install step.
HERE = Path(__file__).resolve()
sys.path.insert(0, str(HERE.parents[1] / "sdk-py"))

import httpx  # noqa: E402

from smartnote_cloud import Client, SmartNoteError  # noqa: E402


BASE = os.getenv("BASE", "http://localhost:58000")


def wait_for_health(timeout: float = 60.0) -> None:
    """Poll /v1/health — the quickstart script brings services up in
    parallel and the api container is ready a few seconds after embed."""
    deadline = time.time() + timeout
    last_err: Exception | None = None
    while time.time() < deadline:
        try:
            resp = httpx.get(f"{BASE}/v1/health", timeout=3.0)
            if resp.status_code == 200:
                return
        except Exception as e:
            last_err = e
        time.sleep(1.0)
    raise RuntimeError(f"api didn't come up in {timeout}s (last error: {last_err})")


def main() -> int:
    print(f"→ probing {BASE}/v1/health")
    wait_for_health()
    print("✓ api is healthy")

    print("→ bootstrapping tenant / workspace / api key")
    boot = httpx.post(
        f"{BASE}/v1/dev/bootstrap",
        json={
            "tenant_name": "demo",
            "workspace_name": "default",
            "workspace_slug": f"default-{int(time.time())}",
            "api_key_name": "demo-key",
        },
        timeout=10.0,
    )
    if boot.status_code == 404:
        raise RuntimeError(
            "POST /v1/dev/bootstrap returned 404 — set ALLOW_DEV_BOOTSTRAP=true "
            "in cloud/infra/.env and restart the api container."
        )
    boot.raise_for_status()
    info = boot.json()
    api_key = info["api_key"]["secret"]
    workspace_id = info["workspace"]["id"]
    print(f"✓ workspace={workspace_id} key={info['api_key']['prefix']}…")

    with Client(api_key=api_key, base_url=BASE) as sn:
        print("→ writing two memories (preference + fact)")
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
        print(f"  • pref id={pref['id']}")
        print(f"  • fact id={fact['id']}")

        print("→ listing all memories")
        rows = sn.memories.list()
        assert len(rows) == 2, f"expected 2, got {len(rows)}"
        for r in rows:
            print(f"  [{r['kind']}] {r['content'][:60]}")

        print(f"→ fetching pref by id")
        fetched = sn.memories.get(pref["id"])
        assert fetched["id"] == pref["id"]
        print(f"✓ fetched kind={fetched['kind']}")

        print("→ filtering by kind=preference")
        prefs_only = sn.memories.list(kind="preference")
        assert len(prefs_only) == 1

        print("→ deleting the fact")
        sn.memories.delete(fact["id"])
        remaining = sn.memories.list()
        assert len(remaining) == 1
        print(f"✓ {len(remaining)} memory remains")

    print("\n🎉 end-to-end demo passed")
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
        sys.exit(1)
