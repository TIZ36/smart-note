# KP Pipeline Fixes — Execution Plan

Audit of `wiki_abstract` + entity-graph + client KP visibility, 2026-04-30.
Captures the full fix list so subsequent passes don't drop items.

Source diagnosis lives in this conversation; this file is the canonical
checklist. Each item has: what's wrong → file/line → fix → verification.

Do **not** mark an item done until both the code change and its
verification step have been run.

---

## Severity legend

- **P0** — broken now, user-visible. Fix immediately, single PR.
- **P1** — silently lying to the user. Fix in the same PR or directly after.
- **P2** — design debt, schedule for next iteration.

---

## P0-1 — `wiki_phase_b` passes a kwarg the callee doesn't accept

**Symptom**: every wiki abstract run with non-empty entities raises
`TypeError: upsert_entities_for_segments() got an unexpected keyword
argument 'source_kind'`. Because the call is **inside**
`async with conn.transaction():` (wiki_phase_b.py:197), the exception
rolls back the entire batch — every chapter's `summary`, `keywords`,
`summary_sha`, `updated_at` write is reverted. User sees "Build wiki
abstract" succeed at the HTTP level (the route catches nothing) but
DB rows are empty. Re-running just repeats the same failure.

**File**: `cloud/api/app/contexts/knowledge/wiki_phase_b.py:221-225`

**Fix**:
```python
# remove the unsupported kwarg
try:
    await upsert_entities_for_segments(
        conn, workspace_id,
        [{"tag": f"wiki:{cs.title}", "entities": cs.entities}],
    )
except Exception as e:
    log.warning("wiki entity upsert failed for chapter %s: %s",
                cs.chapter_id, e)
```

Wrap in try/except so a single bad chapter doesn't take down the
whole transaction (parity with `enrich.py:145-148`).

**Verification**:
1. Run `pytest cloud/api/tests/test_wiki_phase_b.py` if it exists; if
   not, add a unit test that asserts `summarize_document` writes
   `summary` even when one chapter's entities cause an upsert error.
2. Manually: upload a wiki .md with at least 2 H2 sections, run
   `POST /v1/processing/{id}/run kind=wiki_abstract`, then
   `SELECT id, summary, summary_sha FROM wiki_chapters WHERE document_id=$1`
   — every row must have non-empty `summary` + non-empty `summary_sha`.
3. `/kn` endpoint returns `summarized: true` for every chapter.

---

## P0-2 — wiki_abstract completion is not broadcast

**Symptom**: `processing.py` wiki_abstract branch calls
`summarize_document` inline and returns. There is no
`ws_registry.broadcast(...)` call. The desktop's WebSocket listener
in `App.tsx` only knows `enrich_done`, so:
- KP page progress doesn't update
- Library KN view chapters stay stale until manual reload
- The "客户端没有任何感知" complaint

Parallel: note-side `enrich_done` is broadcast at
`enrich.py:165-184`.

**Files**:
- `cloud/api/app/routers/processing.py:93-112` — wiki_abstract branch
- `desktop/src/App.tsx` — add listener
- `desktop/electron/preload.cjs` / `services/cloud-ws.mjs` — already
  forwards arbitrary message types, no change

**Fix (server)**: after `summarize_document` returns, fire-and-forget:
```python
from app.common import ws_registry
import asyncio as _asyncio
from datetime import datetime, timezone

payload = {
    "type": "wiki_abstract_done",
    "document_id": document_id,
    "chapters": result["chapters"],
    "summarized": result["summarized"],
    "skipped": result["skipped"],
    "failed": result["failed"],
    "at": datetime.now(timezone.utc).isoformat(),
}
try:
    _asyncio.create_task(ws_registry.broadcast(ws, payload))
except Exception:
    pass
```

Same pattern for `chunk_embed` and `ai_enrich` branches in
processing.py — both currently silent. Emit:
- `chunk_embed_done` — `{document_id, chunks, kind}`
- `ai_enrich_done` — only if `queue_enrich_if_eligible` actually ran
  (not the dedup-skipped path)

**Fix (client)**: in `desktop/src/App.tsx` add to the WS message
switch:
```ts
} else if (m.type === "wiki_abstract_done" || m.type === "chunk_embed_done") {
  // Refresh KP/Library state for the doc
  window.dispatchEvent(new CustomEvent("smartnote:doc-pipeline-changed", {
    detail: { document_id: m.document_id, kind: m.type }
  }));
}
```

Then `LibraryDocsPane`, `RAGPage` listen to that event and refetch
`/kn` for the affected doc.

**Verification**:
1. Open desktop, devtools console, watch for the new events
2. Trigger `Build wiki abstract` in KP; chapter list re-renders without
   manual refresh
3. Trigger `Embedding` in KP; chunk count badge updates without reload
4. `grep` codebase for any remaining processing.py paths that don't
   broadcast — none should remain

---

## P1-1 — `gDone` is aliased to `rDone` (G badge is fake)

**Symptom**: `LibraryDocsPane.tsx:574` literally `const gDone = rDone;`
There is no server signal indicating whether `entities` /
`entity_links` / `tag_entities` were actually populated for this doc.
- When entity upsert fails (best-effort try/except swallows), R is
  reported done but graph is empty → G shows green falsely
- When LLM returns `entities: []` for every segment (small notes,
  generic content), graph is empty → G still green
- Combined with P0-1, wiki G is double-fake until P0-1 lands

**Files**:
- `cloud/api/app/routers/documents.py:325-` — `/kn` endpoint
- `cloud/api/app/services/kb/entity_graph.py` — add per-doc count helper
- `desktop/src/components/library/LibraryDocsPane.tsx:574` — read truth
- `desktop/src/lib/cloud-api.ts` — type for new field

**Fix (server)**: add to `/kn` response:
```python
# count entities linked to this document via its segments/chapters
if kind == "wiki_topic":
    # entities attributed via tag_entities where tag = "wiki:<title>"
    entity_count = await conn.fetchval(
        """
        SELECT count(DISTINCT te.entity_id)
        FROM tag_entities te
        WHERE te.workspace_id = $1
          AND te.tag = ANY($2::text[])
        """,
        ws,
        [f"wiki:{ch['title']}" for ch in wiki_chapters],
    )
else:
    # entities attributed via tag_entities where tag IN this doc's segments
    entity_count = await conn.fetchval(
        """
        SELECT count(DISTINCT te.entity_id)
        FROM tag_entities te
        WHERE te.workspace_id = $1
          AND te.tag = ANY(
            SELECT DISTINCT tag FROM tag_segments
            WHERE document_id=$2 AND workspace_id=$1
          )
        """,
        ws, doc,
    )
```

Add `"entity_count": int(entity_count or 0)` to response.

**Caveat** noted: `tag_entities` is workspace-scoped, not per-doc. The
above query is approximate (it counts entities for tags this doc
contributed to, but the entities themselves may have come from other
docs sharing the tag). Acceptable for the badge — "this doc's tags
have N graph entities behind them" is the right semantic. Document
this in the response field's docstring so future readers don't expect
strict per-doc isolation.

**Fix (client)**: `LibraryDocsPane.tsx`:
```ts
const gDone = (knData?.entity_count ?? 0) > 0;
```

For `KnView` types, add `entity_count: number` to `DocumentKn` type
in `cloud-api.ts`.

**Verification**:
1. Upload a doc, run E only → G badge stays grey
2. Run R → if entities extracted, G turns green; if not, stays grey
3. Manually `DELETE FROM entity_links WHERE workspace_id=$1` (simulate
   broken graph) → G turns grey on `/kn` refetch
4. Wiki: chapters with empty entity arrays leave G grey; with entities
   → green

---

## P1-2 — wiki_abstract has no enrich_jobs row → KN "Enrich" tab empty for wikis

**Symptom**: `processing.py` wiki_abstract calls `summarize_document`
directly and never inserts an `enrich_jobs` row. `/kn` queries
`enrich_jobs` only. The Library KN view → Enrich tab for wiki docs
is permanently empty even after successful runs. No history, no
failure visibility.

**Files**:
- `cloud/api/app/routers/processing.py:93-112`
- `cloud/api/app/contexts/knowledge/wiki_phase_b.py` — return token usage too

**Decision**: until the proper `processing_runs` ledger lands (P2-1),
piggyback on `enrich_jobs` with `executor='wiki_phase_b'`.

**Fix**:
```python
if req.kind == "wiki_abstract":
    async with pool().acquire() as conn:
        job = await conn.fetchrow(
            "INSERT INTO enrich_jobs (workspace_id, document_id, status, executor) "
            "VALUES ($1, $2, 'running', 'wiki_phase_b') RETURNING id",
            UUID(ws), UUID(document_id),
        )
    try:
        result = await summarize_document(ws, document_id)
    except Exception as e:
        async with pool().acquire() as conn:
            await conn.execute(
                "UPDATE enrich_jobs SET status='failed', error=$2, "
                "finished_at=now() WHERE id=$1",
                job["id"], str(e),
            )
        raise
    async with pool().acquire() as conn:
        await conn.execute(
            "UPDATE enrich_jobs SET status='done', finished_at=now(), "
            "result=$2::jsonb WHERE id=$1",
            job["id"], json.dumps(result),
        )
```

**Verification**:
1. Run wiki abstract → `SELECT * FROM enrich_jobs WHERE document_id=$1
   ORDER BY created_at DESC LIMIT 1` shows row with
   `executor='wiki_phase_b'`, status `done`, result JSON populated
2. Library KN view → Wiki doc → Enrich tab shows the run with chapter
   counts
3. Force a failure (drop provider config mid-run) → row shows status
   `failed` with error text

---

## P1-3 — wiki_abstract blocks the HTTP request thread

**Symptom**: `processing.py:99` does `result = await summarize_document(...)`.
For a 50-chapter doc with `MAX_PARALLEL_CHAPTERS=4`, the HTTP request
hangs ~30-60 s. Client has no progress indicator. Browser may time
out.

**Decision**: backgrounding is the right move but requires worker
infra. Interim: keep inline but add per-chapter progress broadcast
via WS. The client gets a stream of `wiki_abstract_progress`
events `{document_id, chapter_id, ord, total}` while the request is
in flight. The HTTP response still blocks but the UI shows a live
counter.

**Files**:
- `cloud/api/app/contexts/knowledge/wiki_phase_b.py` — broadcast inside
  `one()` after a chapter is written
- `desktop/src/App.tsx` — listen, route to KP page progress component

**Fix sketch** (in `wiki_phase_b.summarize_document.one()`):
```python
# after successful UPDATE wiki_chapters
try:
    from app.common import ws_registry
    asyncio.create_task(ws_registry.broadcast(workspace_id, {
        "type": "wiki_abstract_progress",
        "document_id": document_id,
        "chapter_id": str(cs.chapter_id),
        "ord": ch_row["ord"],
        "total": len(chapters),
    }))
except Exception:
    pass
```

**Verification**:
1. Process a 10+ chapter wiki, watch desktop devtools — stream of
   progress events arrives at ~1/sec
2. KP page shows "Wiki abstract: 3/10 chapters"
3. Final `wiki_abstract_done` fires after the last progress event

**Defer** (P2): real worker so the request doesn't block.

---

## P2-1 — `processing_runs` ledger ✅ shipped (write-through)

Migration 021 already created the table; commit `dbfcf42` added the
write-through producer:

- `services/processing_runs.py` — `start()` / `finish()` helpers,
  best-effort, never raise into the request path
- `processing.py` writes a row for every branch (chunk_embed,
  ai_enrich, wiki_abstract)
- `/kn` exposes `processing_runs[]` (LIMIT 20) for client preview
- `enrich_jobs` is still the authoritative UI surface

**Follow-ups still required to fully retire enrich_jobs**:
- ✅ commit `c3d6c18` — `enrich.py:_write_segments_done` and inline
  BYOK failure path now call `finish_latest()`. ai_enrich rows close
  out instead of hanging.
- ✅ commit `c7a5edb` — `/kn` Runs tab renders the ledger preview
  alongside the legacy Enrich tab.
- ✅ commit `757ccbd` — legacy `/v1/enrich/run` and MCP
  `/jobs/{id}/submit` paths open + close ledger rows. Combined with
  the dispatcher's funnel, every ai_enrich entry-point is covered.
- ✅ commit `34abdee` — `input_sha` carries content_sha +
  tag_vocab_sha + prompt_version per the migration 021 contract.
  Dedup correctly invalidates on doc edits and vocab changes.
- ✅ commit `ec74e1c` — KP page `RecentRunsFeed` reads from
  `GET /v1/processing/recent`, refreshes on every pipeline WS event.

- ✅ commit `e08f51e` — migration 025 backfills terminal
  `enrich_jobs` rows (done/failed) into `processing_runs`. Idempotent
  via 'backfill:<job_id>' synthetic input_sha. Wiki Phase B rows
  map onto `kind='wiki_abstract'`; everything else is `ai_enrich`.
- ✅ commit `4def060` — Library KN R-done fallback reads
  `processing_runs` instead of `enrich_jobs`. KnTab union narrowed
  (Enrich tab dropped; Runs tab covers all kinds). EnrichHistoryTab
  component deleted.
- ✅ commit `f1f37f5` — `/kn` response no longer emits `enrich_jobs[]`.
  Type definitions cleaned client-side.

- ✅ commit `a168759` — auto-ingest path (DocumentCreated /
  DocumentContentChanged subscribers in knowledge/wiring.py) now
  opens processing_runs rows + broadcasts chunk_embed_done. Every
  ingest path on the cloud writes to the ledger.
- ✅ commit `0a28e02` — background sweeper marks running rows
  >30min as failed-with-timeout. Closes the gap where mcp_pull /
  ws_relay handoffs to a missing agent left rows hanging.

**Still ⏳** (executor refactor, separate PR):
- Migrate `mcp_pull` / `ws_relay` executors to poll `processing_runs`
  (kind='ai_enrich' AND status='queued') instead of
  `enrich_jobs WHERE status='queued'`
- Stop INSERT/UPDATE on `enrich_jobs` from enrich.py + processing.py
- Drop the `enrich_jobs` table

---

## P2-2 — `wiki_chapters.last_error` column ✅ shipped

Commit `83a7f8a`:
- Migration `024_wiki_chapters_last_error.sql` adds nullable column
- `wiki_phase_b.one()` now returns `ChapterFailure` for both LLM-call
  exceptions and empty/invalid JSON responses
- Post-loop stamps `last_error` on failure, clears it (`= NULL`) on
  the next successful run alongside summary write
- `/kn` exposes `chapters[].last_error`
- `ChaptersTab` renders a red dot in the row header + inline mono
  error string under the row

---

## P2-3 — E badge truth ✅ shipped

Commit `d6a567b`:
- `chunks.dimension` is a TEXT topic label, not a vector dim — the
  original plan note was wrong about the column. Truth signal is
  `embedding IS NOT NULL`.
- `/kn` returns `chunk_total` and `embedded_chunk_count` (full COUNT,
  not the LIMIT-200 preview)
- Library KN E badge has three states now: green (all embedded),
  amber `proto-tag-warn` (partial), grey (none) — partial is real
  when the embed pod was unavailable mid-ingest

---

## Out-of-scope (recorded so we don't forget)

- `processing_runs` table design — see processing-pipeline.md §5.2
- WikiGraph / KnowledgeGraph panel UI — currently shows global graph,
  not per-doc subgraph; could surface entity_count from new field
- `tag_entities.tag` for wiki uses `wiki:<title>` prefix; namespace
  collision risk if a note's tag ever starts with `wiki:` literally.
  Switch to a `source_kind` column on `tag_entities` if/when this
  bites.

---

## Execution order

1. **Branch**: `kp-pipeline-fixes`
2. **Commit 1** — P0-1 (wiki_phase_b kwarg + try/except). Smallest,
   most urgent.
3. **Commit 2** — P0-2 (broadcast wiki_abstract_done + chunk_embed_done
   + ai_enrich_done; client listener).
4. **Commit 3** — P1-1 (entity_count in /kn, real gDone).
5. **Commit 4** — P1-2 (enrich_jobs row for wiki_phase_b).
6. **Commit 5** — P1-3 (per-chapter progress broadcast).
7. PR description: link this doc, list which Pn items each commit
   covers.

After merge: re-run the audit (this doc's "Verification" step for
each item) before closing. P2 items become follow-up issues.

---

## Test fixtures to add

If not already present:
- `cloud/api/tests/test_wiki_phase_b.py` — covers P0-1 regression
- `cloud/api/tests/test_processing_router.py` — covers all three
  `kind` branches including their broadcast payload shape
- `desktop/src/components/library/__tests__/LibraryDocsPane.test.tsx`
  — covers gDone independence from rDone

If the repo doesn't have a test runner wired for any of these,
note it but don't block the fix; just add a `// TODO: test` marker
and open a follow-up.
