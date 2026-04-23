"""Contract interfaces for the enrich service.

Three concepts pinned down here:

* `EnrichJob` — what the dispatcher receives. Carries workspace + content
  + executor hint so dispatching is a pure function of the job.
* `Executor` — protocol every execution strategy (cloud_pool / ws_relay /
  mcp_pull) implements. Implementations live under `executors/`.
* `EnrichOutcome` — what comes back: segments + usage + which executor
  actually ran it (used for billing attribution).

Keeping this file tight — anything beyond contract goes in siblings.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal, Protocol

ExecutorKind = Literal["cloud_pool", "ws_relay", "mcp_pull"]


@dataclass
class EnrichJob:
    job_id: str
    workspace_id: str
    document_id: str
    content: str
    tags: list[str] = field(default_factory=list)
    # Caller-provided priority order. Dispatcher will try them in sequence.
    executor_prefs: list[ExecutorKind] = field(default_factory=list)


@dataclass
class EnrichOutcome:
    job_id: str
    segments: list[dict]
    executor: ExecutorKind | None
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0
    error: str | None = None


class Executor(Protocol):
    kind: ExecutorKind

    async def is_available(self, workspace_id: str) -> bool: ...

    async def run(self, job: EnrichJob) -> EnrichOutcome: ...
