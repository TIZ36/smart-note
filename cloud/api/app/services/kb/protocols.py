"""Contract surface for the kb (knowledge-base) service.

Kept tiny on purpose — the kb interface has historically grown warts
(wikis, smart tables, graph extraction all attached to retrieval). The
rule for this file: if it doesn't belong on the "how the router talks
to the ranker" path, it lives in a sibling module, not here.
"""

from __future__ import annotations

from typing import Protocol

from app.services.kb.hybrid import HybridResult


class Retriever(Protocol):
    async def search(
        self,
        query: str,
        workspace_id: str,
        topk: int = 10,
        weights: dict[str, float] | None = None,
    ) -> list[HybridResult]: ...
