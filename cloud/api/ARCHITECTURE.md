# SmartNote Cloud — Architecture

This is the **target** architecture, not a faithful description of every
file today. New code MUST honor it; existing code is migrated
opportunistically. `import-linter` enforces the rules in CI
(`pyproject.toml`).

## 1. Bounded contexts

The cloud API is divided into 5 contexts. Each context owns a fixed
set of tables and exposes a public service interface. Other contexts
must go through that interface — direct cross-context SQL is
forbidden.

```
┌───────────────────────────────────────────────────────────────────┐
│                     api domain (always-on, light)                  │
│                                                                    │
│  identity                storage              telemetry            │
│  ────────                ───────              ─────────            │
│  tenants                 documents            workspace_usage      │
│  workspaces              (raw content)        workspace_usage_     │
│  api_keys                                       monthly            │
│  devices                                      search_history       │
│  pairing_codes                                                     │
└───────────────────────────────────────────────────────────────────┘
                                │
                                │  events: DocumentCreated,
                                │          DocumentUpdated,
                                │          DocumentDeleted
                                ▼
┌───────────────────────────────────────────────────────────────────┐
│                  smart domain (heavy, async, ML-bound)             │
│                                                                    │
│  knowledge                                  enrichment             │
│  ─────────                                  ──────────             │
│  chunks                                     enrich_jobs            │
│  tag_segments                               workspace_tags         │
│  entities                                   memories[kind=         │
│  entity_links                                  preference, key=    │
│  wiki_nodes                                    enrich_provider]    │
│  memories[kind=fact / episode /                                    │
│           document_ref / proposal /         executors:             │
│           preference (non-enrich)]           - mcp_pull            │
│                                              - ws_relay            │
│  retrieval (hybrid: chunks + memories)       - cloud_pool          │
│  graph (entities + co-occurrence edges)                            │
│  wiki (topic tree + dedupe + reorganize)                           │
└───────────────────────────────────────────────────────────────────┘
```

### Context inventory

| Context | Owns these tables | Responsibility | Future split |
|---|---|---|---|
| **identity** | `tenants`, `workspaces`, `api_keys`, `devices`, `pairing_codes` | auth, JWT, scope, device pairing, primary device election | api |
| **storage** | `documents` | raw doc CRUD; does NOT know what AI does with the content | api |
| **knowledge** | `chunks`, `tag_segments`, `entities`, `entity_links`, `wiki_nodes`, `memories` (incl. proposals + non-enrich preferences) | chunk + embed + hybrid retrieval; entity graph; wiki topology; agent-facing memory store. Memory is treated as a sub-shape of "knowledge" (a different storage form alongside chunks). | **smart** |
| **enrichment** | `enrich_jobs`, `workspace_tags`, `memories[kind=preference, content=enrich_provider]` | LLM tag classification job lifecycle (queue / dispatch / executor selection / result write-back). Owns the workspace's classification taxonomy (workspace_tags) and the LLM provider config. | **smart** |
| **telemetry** | `workspace_usage`, `workspace_usage_monthly`, `search_history` | usage metering; activity feed; console aggregator | api |

### Cross-context coupling rules

1. **No cross-context SQL.** A context never reads / writes another
   context's tables. Need data from another context? Call its
   `service.py` public function.
2. **Memory is owned by knowledge, but enrichment writes the
   `preference` rows that store provider config.** This is the one
   sanctioned shared table. Ownership rule: `kind='preference' AND
   content='enrich_provider'` is enrichment's; everything else in
   `memories` is knowledge's. After the smart split, both tables move
   to smart together — no cross-service shared state.
3. **Events for write-side fan-out, direct calls for read-side
   queries.** Storage publishes `DocumentCreated`; enrichment +
   knowledge subscribe. But console querying current counts goes
   through direct service calls (`telemetry.service.snapshot()` calls
   `knowledge.service.count_for(ws)` etc.).
4. **Memories table cardinality.** Knowledge writes `kind=fact /
   episode / document_ref / proposal`. Enrichment writes only
   `kind=preference, content=enrich_provider`. Other preferences
   (general workspace prefs) live in knowledge's preference space.
   The `kind='preference'` namespace is partitioned by `content` key;
   each context registers its keys in its module docstring.

## 2. Layering within a context

```
contexts/<name>/
  router.py       transport — FastAPI; req/resp models; scope deps; HTTP codes only
  service.py      use cases — orchestrates repositories + domain;
                  publishes events; calls other contexts' service.py
  repository.py   persistence — SQL; returns typed dataclasses, NOT asyncpg.Record
  domain.py       (optional) pure functions / value objects; no I/O
  models.py       pydantic schemas (request / response shapes)
  events.py       (optional) event types this context publishes
  wiring.py       (optional) subscribes to other contexts' events at startup
```

### Hard import rules

- `router → service → repository`. Skipping a layer is forbidden.
- `repository → service` is forbidden (no upward import).
- `import fastapi` is allowed only inside `router.py`.
- `import asyncpg` is allowed only inside `repository.py` and `infra/`.
- Cross-context imports go through `service.py`; no
  `from app.contexts.X.repository import ...` from another context.
- `domain.py` imports nothing from `app.*` except other `domain.py`
  modules and stdlib.

## 3. Infrastructure layer

```
app/infra/
  db.py              asyncpg pool + migrations
  embed.py           embed-pod HTTP client
  events.py          in-process pub/sub (replaceable with Redis later)
  jwt.py             token mint / verify
  redis.py           (future) when we move events out of process
```

`infra` is allowed to be imported from anywhere. It must not import
from `app.contexts.*`.

## 4. Event contracts

These are the only events crossing contexts. Add new ones here before
publishing.

| Event | Publisher | Subscribers | Payload |
|---|---|---|---|
| `DocumentCreated` | storage | knowledge (chunk+embed), enrichment (queue if auto/force) | `workspace_id`, `document_id`, `smartnote_type`, `force_enrich` |
| `DocumentUpdated` | storage | knowledge (re-chunk when content changed) | `workspace_id`, `document_id`, `content_changed` |
| `DocumentDeleted` | storage | knowledge cleanup is automatic via FK CASCADE | `workspace_id`, `document_id` |
| `EnrichJobCompleted` | enrichment | telemetry (activity feed), knowledge (entity graph) | `workspace_id`, `job_id`, `document_id`, `segments_count` |

## 5. Migration path to smart-cloud split

When the time comes (see `loop` skill / project_tob_direction memory
for triggers):

1. `mv app/contexts/{knowledge,enrichment} smart-service/`
2. Replace `app.infra.events` with a Redis stream / Postgres
   `LISTEN/NOTIFY` adapter — handler signatures don't change.
3. The two contexts move to a new repo or a new `smart/api/` subtree;
   they keep talking to the same Postgres for now (shared DB phase).
4. Phase 2 of the split: smart gets its own DB, storage publishes
   `DocumentCreated` with content payload (fat events) so smart no
   longer reads `documents`.

If steps 4 stays unnecessary forever, that's fine — shared DB +
process-split is a stable end state for many products.

## 6. What's NOT decided here

- **GraphRAG / reranker placement** — when added, they live inside
  knowledge. If they grow to need their own data store (graph DB,
  separate vector index), they may earn their own context.
- **Billing / quota enforcement** — currently telemetry just meters.
  When enforcement lands, it could either stay in telemetry or earn
  its own `billing` context. Decide when paid tier ships.
- **Async ingest worker** — when enrichment grows past in-process
  background tasks, the same role-split pattern applies (one image,
  `ROLE=worker` env). No new context needed.
