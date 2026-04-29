# Processing Pipeline (v1.2 design — pass 2)

| | |
|---|---|
| Status | **Design — approved; P0 ready to start.** |
| Drafted | 2026-04-28 |
| Revised | 2026-04-28 (pass 1) → 2026-04-28 (pass 2, cloud-team) |
| Authors | Desktop + Cloud joint |
| Reviewers | Cloud team (pass 1 + pass 2 incorporated) |
| Replaces | `_schedule_auto_ingest` flow in `cloud/api/app/routers/documents.py` |
| Related | [architecture.md](./architecture.md), [retrieval.md](./retrieval.md), [tag-system.md](./tag-system.md) |

### Revision summary

**Pass 1** (cloud-team review of original draft) — fixed:
- Generated column → trigger + CONCURRENTLY index (Postgres
  correctness)
- `chunk_blobs.ref_count` → nightly orphan GC (race elimination)
- `processing_runs` audit-preserving force re-run via `revision`
- `wiki_chapters.entity_ids` removed (single source: `entity_links`)
- `force_enrich` semantics tied to `input_sha`
- Memory shards + topology moved out of v1.2 (§12)
- Quota / retry / auth / abuse / backfill sections added
- Effort 15 → 20 working days

**Pass 2** (cloud-team second pass) — additional fixes:
- **B1'**: pgvector `VECTOR` (no dimension) is incompatible with
  HNSW. Pinned to `VECTOR(384)` matching production embedder
  (all-MiniLM-L6-v2). Added `embedding_model TEXT` label so we can
  identify the producing model without losing index compatibility.
  Multi-embedder support is explicitly out of scope; reach for it
  via table partitioning when actually needed.
- **H1'**: HNSW index gains `WHERE embedding IS NOT NULL` (HNSW
  cannot contain NULL rows).
- **H2'**: dropped 30-day `+billing` grandfather (footgun —
  silent failures at day 31, white-listed force-rerun for 30 days).
  Replaced with per-workspace `legacy_billing_enforcement` toggle:
  default `true` (strict), workspace owner can opt out via Cloud
  Console settings page. New workspaces are strict from day 1; old
  workspaces stay strict by default but get a Console banner.
- **H3'**: unified Phase B billing rule across `kind`. **Auto-mode
  runs** (workspace setting on) need only `documents:write`.
  **Force re-runs** + **writing the workspace setting** need
  `+billing`. The "money decision" is centralized at the toggle, not
  per-call.
- **H4'**: `chunk_refs` gains `UNIQUE (document_id, ord)`; backfill
  script uses `ON CONFLICT DO NOTHING`. Backfill safe to run
  alongside dual-write.
- **M1'**: `processing_runs.input_snapshot JSONB` captures
  `{tag_vocab_sha, prompt_version, content_sha, executor_kind}` at
  enqueue time. Runs are reproducible and auditable; tag-table edits
  between enqueue and execute can't change a run's behavior.
- **M2'**: `triggered_by` split into `trigger_kind` + `trigger_ref`.
  Aggregations in dashboards no longer parse strings.
- **Telemetry**: `cost_cny` → `cost_usd_micros BIGINT` (integer,
  no float, multi-currency display done at consumption layer).
- **Tests**: added auth-scope tests + `+billing` toggle tests.

---

## 0. TL;DR

We are replacing the implicit "every upload triggers chunk + embed +
maybe LLM" flow with an explicit two-phase, type-aware, deduped
pipeline:

- **Phase A** (always, fast, no LLM): chunk + embed + FTS, with
  **chunk-level dedup** so re-uploading a near-identical doc reuses
  existing rows and embeddings.
- **Phase B** (opt-in, LLM): per-type — `note` enriches into tag
  segments, `wiki_topic` produces a per-H2 abstract sheet.
- **One progress surface** (`processing_runs` table + single endpoint)
  so Desktop, AI CLI, and Cloud Console all see the same live state.

Out of scope for v1.2 (separate designs): memory shards, KB topology
walks, chapter `see_also` graph, note→memory distillation. Reasoning
in §12.

20 working days (1 engineer), 5 phases, each ships a working slice.
Migration is additive — old code keeps working during transition.

---

## 1. Why we're doing this

### 1.1 Problems with the current flow

| Symptom | Root cause |
|---|---|
| Same content uploaded twice = 2× embedding cost, 2× LLM cost | No dedup at any layer (no doc sha, no chunk sha) |
| "Wiki" 50KB markdown gets paragraph-chunked exactly like a note | Single chunker, no `smartnote_type` branching |
| Desktop polls `/v1/documents/{id}/pipeline`, Cloud Console polls `/v1/enrich/jobs`, AI CLI polls `/v1/enrich/pending` — all show different shapes | Three progress tables |
| User clicks "Ingest All" twice → two queued LLM jobs | No idempotency (no `processing_runs` table yet) |
| "Wiki abstract sheet" doesn't exist as a concept | No chapter table; UI shows raw markdown |

### 1.2 Design constraints (non-negotiable)

- **Idempotent uploads.** Pasting the same note 3 times produces 1
  embedding cost, 1 LLM cost, 1 doc visible to retrieval.
- **Cost-aware default.** Phase A costs ~free; Phase B costs real
  money. Phase B never runs without explicit consent (per-workspace
  setting OR per-doc `force_enrich` flag).
- **Cross-client parity.** Whatever progress Desktop sees, AI CLI and
  Cloud Console see byte-identical. No client-specific state.
- **No breaking reads during migration.** Existing search + tag
  queries keep working off legacy tables until P4 flips reads.
- **Audit chain preserved.** `processing_runs` rows are *append-only*;
  forced re-runs create new rows, never overwrite history.

### 1.3 Why these choices

Three product calls; cloud team can challenge with full context:

1. **Dedup at chunk granularity, not just doc-level.** Doc-level
   sha256 catches "same paste, same name" only. Chunk-level catches
   "edited 1 paragraph in a 200-paragraph wiki" — the dominant cost
   source for wiki maintenance. Tradeoff: ~3× more table rows
   (chunks > docs) and an additional join on read. Mitigated by
   `chunk_blobs` being workspace-scoped (not global) so the working
   set per query stays bounded.

2. **Wiki splits to H2 only (no recursive H3/H4).** Most user wikis
   are organized as "topic = H1, sections = H2, paragraphs under H2".
   Splitting to H4 produces more nodes than the LLM summary budget
   can usefully describe. Falls back to "single chapter" gracefully
   for wikis with no H2.

3. **Audit-preserving force re-run** (added in pass 1). `force_enrich`
   does not delete the prior `processing_runs` row; it bumps
   `revision`, which feeds `input_sha`, which queues a fresh row.
   Means we can always answer "who triggered which run, with which
   prompt version, on which content sha" from a single table.

---

## 2. Data model

All schema changes are **additive**. Existing tables and indexes are
untouched until P5.

### 2.1 Document-level fingerprint  *(revised — no generated column)*

**Why not generated:** `ALTER TABLE … ADD COLUMN … GENERATED ALWAYS
AS … STORED` requires a full table rewrite in PostgreSQL — minutes
of exclusive lock on a prod-sized `documents`. INVALID/VALIDATE only
applies to CHECK constraints, not generated columns.

```sql
-- Step 1: plain nullable column. Constant-time DDL.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS content_sha256 TEXT;

-- Step 2: write trigger so all *new* INSERTs populate the column.
CREATE OR REPLACE FUNCTION documents_set_content_sha256()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.content_sha256 IS NULL AND NEW.content IS NOT NULL THEN
    NEW.content_sha256 := encode(digest(NEW.content, 'sha256'), 'hex');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS documents_content_sha256_ins ON documents;
CREATE TRIGGER documents_content_sha256_ins
  BEFORE INSERT OR UPDATE OF content ON documents
  FOR EACH ROW EXECUTE FUNCTION documents_set_content_sha256();

-- Step 3: chunked backfill of existing rows. Run as a job, not in the
-- migration. Each loop is a short transaction; safe to run live.
-- DO $$
-- DECLARE rows_changed INT;
-- BEGIN
--   LOOP
--     UPDATE documents SET content_sha256 =
--       encode(digest(content,'sha256'),'hex')
--     WHERE id IN (
--       SELECT id FROM documents
--       WHERE content_sha256 IS NULL
--       ORDER BY id LIMIT 5000
--     );
--     GET DIAGNOSTICS rows_changed = ROW_COUNT;
--     EXIT WHEN rows_changed = 0;
--     PERFORM pg_sleep(0.05);
--   END LOOP;
-- END $$;

-- Step 4: build the unique index without locking writes.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS documents_dedup
  ON documents(workspace_id, content_sha256);
```

`pgcrypto` already enabled (used by `gen_random_uuid()`).

**Behavior change in `POST /v1/documents`:**

```python
# Compute sha in Python (same algorithm as the trigger), use it in the
# INSERT so we don't depend on RETURNING through the trigger.
sha = hashlib.sha256(content.encode("utf-8")).hexdigest()
row = await conn.fetchrow(
    "INSERT INTO documents(...) VALUES(...) "
    "ON CONFLICT (workspace_id, content_sha256) DO NOTHING "
    "RETURNING id, ...", ...
)
if row is None:                       # conflict — fetch existing
    row = await conn.fetchrow(
        "SELECT id, ... FROM documents "
        "WHERE workspace_id=$1 AND content_sha256=$2",
        workspace_id, sha,
    )
    dedup_hit = True
else:
    dedup_hit = False
```

Response gains a top-level field:

```json
{
  "id": "...",
  "name": "...",
  "...": "...",
  "dedup": { "doc_hit": true }
}
```

`dedup.doc_hit=true` → Phase A is skipped; Phase B is also skipped
*unless* `metadata.force_enrich=true` (which bumps `revision` —
see §2.3).

**No `document_aliases` table** *(L1 resolved — simpler beats
complete)*. The same content uploaded under two names returns the
same `id`; the second name is silently lost. This is a deliberate
simplification — names are user-affordances, content is the identity.
If a use case for multi-name surfaces in v1.3, revisit.

### 2.2 Chunk-level dedup  *(pass 2 — fixed dim, partial HNSW, ref unique)*

**Why no ref_count:** the originally-proposed per-row trigger creates
three problems: race between concurrent same-chunk uploads (`EXCLUDED`
can't self-add), cascade delete N×UPDATE storm, and HNSW churn on
`ref_count=0` deletes. Replaced with nightly orphan GC (§2.7).

**Why fixed `VECTOR(384)`:** pgvector's HNSW index requires a known
dimension at index creation. `VECTOR` (no size) compiles but cannot
back an HNSW index. Production today uses `all-MiniLM-L6-v2` → 384.
We pin to that and label the producing model on each row. Multi-
embedder support (BGE-M3 1024-dim, etc.) is **explicitly out of
scope** for v1.2; if/when added, the path is partition tables
(`chunk_blobs_384`, `chunk_blobs_1024`) routed by model name, not a
schema-level multi-dim shimmy. Same shape as today's `chunks` table.

```sql
CREATE TABLE chunk_blobs (
  workspace_id     UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  content_sha      TEXT NOT NULL,            -- sha256 of canonicalized text
  text             TEXT NOT NULL,
  embedding        VECTOR(384),              -- fixed dim; matches HNSW
  embedding_model  TEXT NOT NULL,            -- e.g. 'all-MiniLM-L6-v2';
                                             -- label only, NOT a multi-dim flag
  keywords         JSONB NOT NULL DEFAULT '[]'::jsonb,
  fts              TSVECTOR GENERATED ALWAYS AS (to_tsvector('simple', text)) STORED,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, content_sha)
);

-- HNSW cannot contain NULL rows. Embeddings are populated AFTER the
-- blob lands (we INSERT the row first to lock the sha, then UPDATE
-- with the vector when the embed call returns). Partial index keeps
-- HNSW happy during that window.
CREATE INDEX chunk_blobs_emb
  ON chunk_blobs USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL;

CREATE INDEX chunk_blobs_fts
  ON chunk_blobs USING gin (fts);

CREATE TABLE chunk_refs (
  id            BIGSERIAL PRIMARY KEY,
  workspace_id  UUID NOT NULL,
  document_id   UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  chunk_sha     TEXT NOT NULL,
  line_start    INT NOT NULL,
  line_end      INT NOT NULL,
  ord           INT NOT NULL,             -- position within doc, 0-based
  ingest_run_id UUID NOT NULL,
  FOREIGN KEY (workspace_id, chunk_sha)
    REFERENCES chunk_blobs(workspace_id, content_sha)
);
CREATE INDEX chunk_refs_doc ON chunk_refs(document_id, ord);
CREATE INDEX chunk_refs_blob ON chunk_refs(workspace_id, chunk_sha);

-- Unique on (doc, ord) lets dual-write + backfill use ON CONFLICT
-- DO NOTHING for idempotent inserts. Without this, a backfill row
-- racing a live write would produce duplicate refs.
CREATE UNIQUE INDEX chunk_refs_doc_ord
  ON chunk_refs(document_id, ord);
```

**Canonicalization (the function whose hash we store):**

```python
import re

_BOM = "﻿"
_INLINE = re.compile(r"[ \t]+")

def canonicalize(text: str) -> str:
    if not text: return ""
    if text.startswith(_BOM): text = text[1:]
    # CRLF/CR → LF first; outer strip; per-line rstrip catches editor
    # trailing-whitespace drift; collapse inline runs.
    text = text.replace("\r\n", "\n").replace("\r", "\n").strip()
    text = "\n".join(line.rstrip(" \t") for line in text.split("\n"))
    return _INLINE.sub(" ", text)
```

The implementation lives in `app/infra/canonical.py` (P1-1) with 64
unit tests covering BOM, CRLF, tab/space drift, fenced/indented code,
unicode whitespace preservation, emoji/ZWJ, multilingual content,
idempotency, and known-collision pairs.

50+ unit tests (§9) cover BOMs, CRLF, tab/space drift, fenced code
blocks, multilingual whitespace, emoji.

**Read view that current search code can use unchanged:**

```sql
CREATE OR REPLACE VIEW chunks_v AS
  SELECT
    cr.id              AS id,
    cr.workspace_id    AS workspace_id,
    cr.document_id     AS document_id,
    cr.line_start      AS line_start,
    cr.line_end        AS line_end,
    cr.ord             AS ord,
    cr.ingest_run_id   AS ingest_run_id,
    cb.text            AS text,
    cb.embedding       AS embedding,
    cb.embedding_model AS embedding_model,  -- replaces legacy `dimension`
    cb.keywords        AS keywords,
    cb.fts             AS fts
  FROM chunk_refs cr
  INNER JOIN chunk_blobs cb
    ON cb.workspace_id = cr.workspace_id
   AND cb.content_sha  = cr.chunk_sha;
```

**Performance acceptance criteria** (H1): P1-3 must run EXPLAIN
ANALYZE on prod-sized data for the three retrieval shapes —
vector top-K, FTS top-K, hybrid — and demonstrate ≤30%
regression vs. legacy `chunks`. If regression exceeds budget,
denormalize `(document_id, line_start, line_end, ord)` into
`chunk_blobs` (duplicating ref data on each blob row, accepting
write-side cost for read-side speed). Decision gate before P1-4.

### 2.3 Unified processing runs  *(pass 2 — input_snapshot + split trigger)*

```sql
CREATE TABLE processing_runs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  document_id  UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,           -- chunk_embed | ai_enrich | wiki_abstract
  status       TEXT NOT NULL,           -- queued | running | done | failed | skipped_dedup | skipped_quota
  executor     TEXT,                    -- cloud_pool | mcp_pull | ws_relay | inline
  progress     JSONB NOT NULL DEFAULT '{}'::jsonb,
  result       JSONB,
  error        TEXT,

  -- input_sha = sha256 over the snapshot below — any change in the
  -- snapshot's value invalidates dedup, which is exactly what we
  -- want. Stored as a TEXT for indexability; computed in service.py.
  input_sha    TEXT NOT NULL,

  -- Snapshot of every input that participated in input_sha, captured
  -- at enqueue time. This is the source of truth at execute time —
  -- the executor reads from here, NOT from current workspace state.
  -- Means: editing workspace_tags between enqueue and execute leaves
  -- the queued run unaffected (it carries the tag list it was queued
  -- with); a re-enqueue captures fresh state. Reproducible runs;
  -- post-mortem from a single row.
  -- Shape:
  --   { "tag_vocab_sha": "...",
  --     "tag_vocab":     ["learn", "todo", ...],
  --     "prompt_version": "v3",
  --     "content_sha":    "...",
  --     "executor_kind":  "cloud_pool",
  --     "revision":       0 }
  input_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Bumped by force=true. Carried into input_sha. Append-only.
  revision     INT NOT NULL DEFAULT 0,

  -- "Who/what asked for this", split into kind + ref so dashboards
  -- can aggregate without parsing strings:
  --   trigger_kind = 'auto'    : ref = 'document_created' | 'document_updated'
  --   trigger_kind = 'api_key' : ref = api_keys.id (UUID)
  --   trigger_kind = 'cron'    : ref = job name
  trigger_kind TEXT NOT NULL,
  trigger_ref  TEXT NOT NULL,

  attempts     INT NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at   TIMESTAMPTZ,
  finished_at  TIMESTAMPTZ
);
CREATE INDEX runs_doc_kind
  ON processing_runs(document_id, kind, created_at DESC);
CREATE INDEX runs_pending
  ON processing_runs(workspace_id, kind, created_at)
  WHERE status IN ('queued', 'running');
CREATE INDEX runs_trigger
  ON processing_runs(workspace_id, trigger_kind, trigger_ref, created_at DESC);
-- Active dedup: at most one non-terminal-or-done run per (doc, kind,
-- input_sha). Failed/skipped rows are excluded so retries work; done
-- rows participate so re-asking returns the existing one.
CREATE UNIQUE INDEX runs_dedup
  ON processing_runs(workspace_id, document_id, kind, input_sha)
  WHERE status IN ('queued', 'running', 'done');
```

**Force re-run semantics** *(M3 resolved):*

```python
# force=true path
prior = SELECT max(revision) FROM processing_runs WHERE doc=? AND kind=?
new_revision = (prior or 0) + 1
new_input_sha = sha256(content_canonical || tag_vocab || prompt_v || str(new_revision))
INSERT INTO processing_runs(..., revision=new_revision, input_sha=new_input_sha, ...)
```

`force=true` always succeeds (no unique-violation) because the new
`input_sha` differs from any existing row's. Audit log: every run
ever attempted is queryable, including the chain of force re-runs.

**Retry policy** (added — was missing):

| `attempts` | Behavior |
|---|---|
| 0 → 1 | Initial run. On failure, schedule retry after exponential backoff (60s × 2ⁿ, capped at 1h). |
| 1 → 2 → 3 | Each retry bumps `attempts`, NULLs `error`/`finished_at`, status → `queued`. |
| 3 → 4 | Mark `status='failed'`, set `error="max retries"`, stop. User sees red badge in UI; can manually `force=true` to start fresh chain. |

Retries are *in-place* on the same row (don't create new
`processing_runs` rows for retries — those are reserved for *force
re-runs* by humans). Distinguishes "system tried 3 times" from
"user asked twice".

### 2.4 Wiki chapters  *(revised — no entity_ids)*

```sql
CREATE TABLE wiki_chapters (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID NOT NULL,
  document_id   UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  ord           INT NOT NULL,           -- 0-based position within doc
  level         INT NOT NULL,           -- always 2 in v1.2 (H2-only)
  anchor        TEXT NOT NULL,          -- slugified heading
  title         TEXT NOT NULL,
  line_start    INT NOT NULL,
  line_end      INT NOT NULL,
  -- Phase B fields, NULL until ai_enrich for this chapter completes.
  summary       TEXT,
  keywords      JSONB,
  -- entity_ids removed: sole source of truth is entity_links rows
  -- with source_kind='wiki_chapter' (M2 fix). One write path, no drift.
  summary_sha   TEXT,                   -- sha of canonicalize(chapter_text); skip if unchanged
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ
);
CREATE UNIQUE INDEX wiki_chapters_doc_ord
  ON wiki_chapters(document_id, ord);
CREATE INDEX wiki_chapters_anchor
  ON wiki_chapters(document_id, anchor);
```

**`entity_links` extension** (additive to existing table):

```sql
ALTER TABLE entity_links ADD COLUMN IF NOT EXISTS source_kind TEXT;
-- Existing rows are implicitly source_kind='note_doc' (the only kind
-- that wrote to this table before v1.2). One-time backfill UPDATE.
```

The "wiki abstract sheet" the UI sees is:

```sql
SELECT title, summary, keywords
FROM wiki_chapters
WHERE document_id = $1
ORDER BY ord;
```

Entity badges per chapter come from a left-join on `entity_links`
filtered by `source_kind='wiki_chapter'`.

### 2.5 ~~Memory shards~~  *(moved to separate design)*

Memory shards solve a different problem (sharded long-term memory)
than dedup; the cloud team correctly observed they were scope-creep.
Now in [memory-shards.md](./memory-shards.md) — TODO, separate
owner. v1.2 leaves the existing `memories` table untouched.

### 2.6 ~~Topology~~  *(deferred to v1.3)*

The KB topology (chapter `see_also` graph, multi-hop walks,
note→memory distillation) depends on this design landing first but
is a separate effort. Captured in the v1.3 backlog. Adding
`source_kind` to `entity_links` (§2.4) is the only change to today's
graph schema; topology walks build on top.

### 2.7 Orphan GC for chunk_blobs  *(replaces ref_count)*

```sql
-- Daily cron in the API pod (the codebase already has nothing like
-- this; we add a tiny one-shot loop with a simple scheduler).
DELETE FROM chunk_blobs cb
WHERE NOT EXISTS (
  SELECT 1 FROM chunk_refs cr
  WHERE cr.workspace_id = cb.workspace_id
    AND cr.chunk_sha    = cb.content_sha
);
```

Until the cron fires, orphaned blobs sit harmlessly in the table.
`chunks_v` is an INNER JOIN, so retrieval can never see an orphan.
Storage cost is bounded — at worst a day's churn of unique chunks.

---

## 3. Event flow

```
Client (Desktop / AI CLI / Cloud Console)
        │
        │  POST /v1/documents { name, content, metadata }
        ▼
┌───────────────────────────────────────────────────────┐
│  storage ctx                                          │
│  1. content_sha256 (Python hashlib, NOT generated col)│
│  2. INSERT ... ON CONFLICT DO NOTHING                 │
│  3. if conflict: fetch existing                       │
│  4. publish DocumentCreated{id, type, force_enrich,   │
│                              dedup_hit, triggered_by} │
│  5. return { id, dedup: {doc_hit} }                   │
└───────────────────────────────────────────────────────┘
                         │
        ┌────────────────┼────────────────┐
        ▼                                 ▼
┌─────────────────────┐         ┌─────────────────────┐
│  knowledge ctx      │         │  enrichment ctx     │
│  Phase A (gated by  │         │  Phase B (gated by  │
│   dedup_hit)        │         │   force_enrich OR   │
│                     │         │   ws.auto_enrich)   │
│                     │         │                     │
│  if dedup_hit:      │         │  if no quota: skip  │
│    no chunking;     │         │    (status=         │
│    Phase A done.    │         │     skipped_quota)  │
│  else:              │         │  else by type:      │
│    chunk → blobs    │         │    note → enrich    │
│    + refs;          │         │    wiki → abstract  │
│    embed only       │         │    other → no-op    │
│    NULL embeddings. │         │                     │
│                     │         │  snapshot inputs:   │
│  enqueue            │         │   tag_vocab_sha     │
│  processing_runs    │         │   prompt_version    │
│  kind=chunk_embed   │         │   content_sha       │
│  trigger_kind=auto  │         │   executor_kind     │
│  trigger_ref=       │         │   revision          │
│   document_created  │         │  → input_snapshot   │
│  input_snapshot=    │         │  → input_sha        │
│   {model, content_  │         │                     │
│    sha, ...}        │         │  enqueue            │
│                     │         │  processing_runs    │
│                     │         │  (unique idx blocks │
│                     │         │   duplicate clicks) │
└─────────────────────┘         └─────────────────────┘
```

---

## 4. Per-type processors  *(memory removed)*

Each processor is a Python module under
`cloud/api/app/services/processors/`. The dispatcher in the
`DocumentCreated` handler is a single `match` on `smartnote_type`.

### 4.1 Note (`smartnote_type=note`)

- **Phase A**: existing paragraph chunker (200–1500 chars), now
  writing to `chunk_blobs` + `chunk_refs`. FTS comes free from
  `chunk_blobs.fts`.
- **Phase B**: `services/enrich/classifier.py` (current code,
  refactored to read `chunk_refs` rather than re-chunk the doc).
  Writes `tag_segments` (existing path).

(Note→memory distillation deferred to v1.3 along with memory shards.)

### 4.2 Wiki (`smartnote_type=wiki_topic`)

**Phase A.**

```
1. Markdown lexer (existing markdown-it equivalent or hand-roll
   line-scanner) — find every line matching ^##\s+(.+)$, EXCEPT
   inside fenced code blocks.
2. For each H2 (and the implicit "preamble" before the first H2):
     create wiki_chapters row { ord, level=2, title, anchor, line_range }
     paragraph-chunk the chapter content → chunk_blobs / chunk_refs
3. Edge cases the splitter handles (covered by P2-1 tests):
     - Fenced code block containing `## stuff` — must NOT split
     - setext-style headings (Title\n=== / ---) — recognized as H1/H2
     - Indented headings (4+ spaces) — treat as code, NOT a heading
     - CRLF / mixed line endings — normalize before lexing
     - No H2 in the doc → single "preamble" chapter spanning the whole doc
     - Multilingual headings (`## 一、概述`) — title preserved verbatim
```

H2 only. Anything below H2 stays inside the parent chapter.

**Phase B.** Per chapter where `summary_sha != sha(canonicalize(chapter_text))`:

```
LLM input: { chapter title, full chapter text, workspace_tags }
LLM output (JSON): {
  "summary": "1-3 sentences in the doc's language",
  "keywords": ["..."],
  "entities": [{"name": "...", "type": "..."}]
}
```

Update `wiki_chapters` row. Link entities into `entities` /
`entity_links` (using `source_kind='wiki_chapter'`). Record new
`summary_sha`. Skipped chapters cost nothing.

**Per-doc concurrency cap**: 4 chapters in flight at a time
(reuses `classifier.max_concurrency`).

---

## 5. API contract

### 5.1 Existing endpoints (behavior changes)

| Endpoint | Change |
|---|---|
| `POST /v1/documents` | Adds `dedup: {doc_hit}` field. Honors `metadata.force_enrich`. ON CONFLICT semantics. |
| `GET /v1/documents/{id}/pipeline` | Returns `runs[]` (§5.3). Old `ingest`/`enrich` fields stay populated for one release. |

### 5.2 New endpoint: trigger / re-trigger a processing run

```
POST /v1/processing/{document_id}/run
  body: { kind: "chunk_embed"|"ai_enrich"|"wiki_abstract", force?: bool }
  response: { run_id, status, dedup_skipped, revision }
```

**Scope rules** (uniform across `kind`):

| Operation | Scope required |
|---|---|
| `kind=chunk_embed` (Phase A) | `documents:write` |
| Phase B (`ai_enrich` / `wiki_abstract`), `force=false` | `documents:write` |
| Phase B, `force=true` | `documents:write` + `billing` |

`force=false` (default) → unique-violation returns the existing
`done` row with `dedup_skipped=true`. Costs nothing.

`force=true` → bumps `revision`, computes new `input_sha`, inserts
new row. Always succeeds and always burns LLM tokens, hence the
`billing` scope. Default-on workspace settings (e.g.
`auto_enrich_on_ingest=true`) burn tokens automatically — those
**don't** require `billing` at call time because the money decision
was made when the setting was written (which itself requires
`billing`, see §6.4).

### 5.3 Pipeline status

```
GET /v1/documents/{id}/pipeline
→ {
    "document_id": "...",
    "dedup": { "doc_hit": false, "chunks_reused": 12, "chunks_new": 4 },
    "runs": [
      { "id": "...", "kind": "chunk_embed", "revision": 0,
        "status": "done", "executor": "inline",
        "trigger_kind": "auto", "trigger_ref": "document_created",
        "attempts": 1,
        "progress": { "phase": "writing" },
        "started_at": "...", "finished_at": "..." },
      { "id": "...", "kind": "ai_enrich", "revision": 0,
        "status": "running", "executor": "cloud_pool",
        "trigger_kind": "auto", "trigger_ref": "document_created",
        "attempts": 1,
        "progress": { "phase": "classifying",
                      "classify": { "done": 120, "total": 350 } } },
      { "id": "...", "kind": "wiki_abstract", "revision": 1,
        "status": "queued", "executor": null,
        "trigger_kind": "api_key", "trigger_ref": "abc-...-uuid",
        "attempts": 0,
        "progress": {} }
    ]
  }
```

`dedup.chunks_reused/chunks_new` are 0 when `doc_hit=true`
(L2 clarification — these counters are for the chunk-level dedup
inside Phase A, and Phase A doesn't run on doc-hit).

Desktop polls 1.2s while any run is queued/running, 5s when idle —
already implemented for the current shape, just maps over `runs[]`
instead of the legacy `ingest`/`enrich` pair.

---

## 6. Quota, retry, and abuse  *(new section — was missing)*

### 6.1 Quota enforcement

`workspaces` already has `quota_*` columns and `usage.bump()` is
called per operation. Phase B extends this:

```python
# Before enqueueing an ai_enrich or wiki_abstract run:
budget = await usage.remaining(workspace_id, kind="llm_tokens_monthly")
if budget <= 0:
    INSERT processing_runs(..., status='skipped_quota',
                           error='monthly LLM token budget exhausted')
    return  # no further work
```

`skipped_quota` is a terminal status (not retried). UI shows a
distinct yellow badge; clicking it opens the workspace billing page.

### 6.2 Retry policy

Per §2.3 retry table. Codified in the dispatcher:

```python
async def maybe_retry(run_id):
    row = await fetch_run(run_id)
    if row.attempts >= 3:
        await mark_failed(run_id, "max retries")
        return
    backoff = min(60 * (2 ** row.attempts), 3600)
    await schedule_after(backoff, lambda: requeue(run_id))
```

### 6.3 Abuse / rate limiting  *(new — was missing)*

Per-workspace upload rate limit at the gateway:

| Endpoint | Limit |
|---|---|
| `POST /v1/documents` | 60 / minute, 200 MB total / hour |
| `POST /v1/processing/{id}/run` | 30 / minute |
| `POST /v1/processing/{id}/run?force=true` | 5 / minute  *(separate bucket — forced runs cost real money)* |

Returns HTTP 429 with `Retry-After` header. Counter implementation:
Redis sliding window (already used elsewhere in cloud).

### 6.4 Auth scopes  *(pass 2 — single billing rule)*

| Scope | Grants |
|---|---|
| `documents:read` | All `GET` endpoints |
| `documents:write` | `POST /v1/documents`, `POST /v1/processing/{id}/run` with `force=false`, sync write paths |
| `billing` (additive) | `force=true` on any Phase B kind; **writing workspace settings that flip auto-mode on** (e.g. `auto_enrich_on_ingest=true`); rotating LLM provider config |

The "money decision" lives at **two** points and **only** these two:

1. **Toggling auto-mode on** (writing the workspace setting).
   Subsequent passive enqueues are free of `billing` because the
   toggle was the consent.
2. **Force re-run** (`force=true` on a single doc).

Default-on flow stays cheap to call: any `documents:write` key can
trigger work that the workspace owner already opted into. Devices
without `billing` can't sneak past the rate-limit + quota by
flipping the toggle.

**Rollout** *(replaces the dropped 30-day grandfather)*:

```sql
ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS legacy_billing_enforcement BOOLEAN
    NOT NULL DEFAULT TRUE;
```

- New workspaces: `legacy_billing_enforcement = TRUE` (strict)
- Existing workspaces (one-time migration): `TRUE`
- Cloud Console banner for every existing workspace shows on first
  visit after release: "Force re-runs and auto-enrich settings now
  require the `billing` scope. [Manage device scopes] [Temporarily
  permit any documents:write key to perform billing actions]"
- Owner can flip to `FALSE` per workspace (writes audit log).
  Code path: when `legacy_billing_enforcement = FALSE`, the
  `billing` check accepts any `documents:write` key. Equivalent to
  pre-release behavior.

No silent day-31 breakage. No 30-day window where the protection is
disabled. Workspaces that explicitly opt to relax enforcement do so
with audit trail.

---

## 7. Migration plan

### 7.1 Phases

```
P0  schema additive (no code reads new tables); no behavior change
    ↓
P1  knowledge ctx writes BOTH legacy chunks AND new chunk_blobs/refs
    + backfill script populates chunk_blobs/refs from legacy chunks
    ↓
P2a wiki Phase A populates wiki_chapters (alongside existing chunks)
P2b wiki Phase B fills summary/keywords + UI surfaces abstract sheet
    ↓
P4  flip reads:
    - search SELECT FROM chunks_v
    - dialogs read processing_runs (legacy fields still populated)
    - desktop EnrichJobsCard reads new shape
    ↓
[soak ≥ 1 release ≈ 1 week]
    ↓
P5  drop dual-write, drop legacy tables, retire _schedule_auto_ingest
```

### 7.2 Rollback

Each phase: `revert PR + drop new tables` is safe because reads stay
on legacy tables until P4. No phase mutates existing data
destructively.

### 7.3 ~~Phase 3~~

Memory shards out of scope per §2.5 / §12.

### 7.4 Backfill script  *(pass 2 — race-safe via ON CONFLICT)*

```python
# cloud/api/scripts/backfill_chunk_dedup.py
#
# Copies every existing `chunks` row into chunk_blobs + chunk_refs.
# Designed to run LIVE alongside dual-write — no maintenance window
# required. Race safety relies on:
#
#   1. chunk_blobs PK (workspace_id, content_sha) → INSERT ON
#      CONFLICT DO NOTHING means concurrent same-sha inserts are
#      idempotent.
#   2. chunk_refs UNIQUE (document_id, ord) → INSERT ON CONFLICT
#      DO NOTHING means a backfill row racing a live dual-write row
#      for the same (doc, ord) loses cleanly; the live row stays.
#
# Without index #2 we could end up with duplicate refs (live writer
# inserts ref for ord=5, backfill inserts another for ord=5, both
# succeed because there's no unique constraint). The index added in
# §2.2 is what makes this script safe to run during dual-write.
#
# Run cadence:
#   - P1-5: initial pass right after dual-write begins.
#   - P4-1: catch-up pass before cutover (sweeps anything new nodes
#     wrote during rolling deploy that the initial pass missed).
#
# Batch size 1000, sleep 50ms. Wall time at current volume scales
# linearly with row count; benchmark in staging before prod run.

BATCH = 1000
async def main():
    while True:
        rows = await pool.fetch("""
            SELECT c.* FROM chunks c
            WHERE NOT EXISTS (
              SELECT 1 FROM chunk_refs cr
              WHERE cr.document_id = c.document_id
                AND cr.ord         = c.ord
            )
            LIMIT $1
        """, BATCH)
        if not rows:
            break
        for r in rows:
            sha = sha256(canonicalize(r['text']).encode()).hexdigest()
            # Race-safe upserts. Both ON CONFLICT clauses are
            # essential — see header comment.
            await pool.execute("""
                INSERT INTO chunk_blobs (workspace_id, content_sha,
                  text, embedding, embedding_model, keywords)
                VALUES ($1, $2, $3, $4, $5, $6)
                ON CONFLICT (workspace_id, content_sha) DO NOTHING
            """, r['workspace_id'], sha, r['text'], r['embedding'],
                r['embedding_model'] or 'all-MiniLM-L6-v2',
                r['keywords'])
            await pool.execute("""
                INSERT INTO chunk_refs (workspace_id, document_id,
                  chunk_sha, line_start, line_end, ord, ingest_run_id)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
                ON CONFLICT (document_id, ord) DO NOTHING
            """, r['workspace_id'], r['document_id'], sha,
                r['line_start'], r['line_end'], r['ord'],
                r['ingest_run_id'])
        await asyncio.sleep(0.05)
```

Lives in `cloud/api/scripts/` — verified in P0-5 (does not run),
executed in P1-5 (initial pass) and again in P4-1 (catch-up).
**Wall time benchmark required in staging** before first prod run —
the original 30-min estimate has no data behind it.

---

## 8. Risks and decisions  *(updated)*

### 8.1 Resolved by these revisions

**Pass 1:**

| Original risk | Resolution |
|---|---|
| Generated column requires table rewrite | §2.1 — plain column + trigger + CONCURRENTLY index |
| `ref_count` race + delete cascade | §2.2 + §2.7 — drop ref_count, nightly GC |
| `processing_runs` dedup destroys audit | §2.3 — append-only with `revision` |
| `wiki_chapters.entity_ids` drifts vs `entity_links` | §2.4 — drop column, single source |
| `force_enrich` semantically dead under dedup | §2.3 + §5.2 — bumps revision → new input_sha |
| Memory + topology bloating scope | §2.5 + §2.6 + §12 — moved out |

**Pass 2:**

| Risk | Resolution |
|---|---|
| `VECTOR` (no dim) + HNSW would not compile | §2.2 — pinned to `VECTOR(384)`, label model on row |
| HNSW with NULL embedding rows would fail | §2.2 — `WHERE embedding IS NOT NULL` partial index |
| Backfill ↔ dual-write race produces duplicate refs | §2.2 + §7.4 — `chunk_refs` UNIQUE (doc, ord) + ON CONFLICT |
| 30-day `+billing` grandfather is silent-failure footgun | §6.4 — replaced with workspace-level `legacy_billing_enforcement` toggle, owner-controlled |
| Per-`kind` billing scope split is arbitrary | §5.2 + §6.4 — single rule: `force=true` or workspace-toggle write needs `billing` |
| `tag_vocab_sha` drift between enqueue and execute | §2.3 — `input_snapshot JSONB` captured at enqueue |
| `triggered_by` high-cardinality string blocks aggregation | §2.3 — split into `trigger_kind` + `trigger_ref` |
| `cost_cny` bakes a single currency | §10.2 — `cost_usd_micros BIGINT` |

### 8.2 Open

| Risk | Mitigation | Owner |
|---|---|---|
| `chunks_v` perf regression > 30% | P1-3 EXPLAIN ANALYZE gate; fall back to denormalized `chunk_blobs` columns per §2.2 acceptance criteria | Cloud team — gate on benchmark |
| Concurrent same-chunk uploads under heavy fan-in | `INSERT ON CONFLICT DO NOTHING` is race-free for blob; refs are independent rows + UNIQUE (doc, ord) so duplicates cannot land | Accepted |
| Markdown heading edge cases break splitter | P2a-1 unit tests cover 8+ scenarios; `--dry-run` flag on first prod doc to inspect output before commit | Engineer |
| Workspace owners forget to flip `legacy_billing_enforcement=FALSE` after granting `billing` to specific devices | Cloud Console banner stays until owner takes action (either grants per-device or explicitly disables enforcement); audit log records both | Cloud team |
| Backfill wall-time at prod scale could exceed soak window | P0-5 includes staging benchmark on prod-size snapshot; estimate goes into the migration runbook | Engineer |
| Bulk sync push (200 docs at once on first device claim) hits 60/min rate limit | Sync engine uses dedicated `/v1/sync/batch` endpoint with separate higher-burst limiter; existing single-doc 60/min stays for ad-hoc API users | Cloud team — needs burst limiter spec in P4 |

### 8.3 Open questions for cloud team  *(updated)*

1. **Embedding provider 32KB chunk limit?** No longer relevant —
   memory shards moved out. Each chunk is paragraph-sized (≤1500
   chars), well within any provider limit.
2. **Workspace-level `processing_runs` retention?** Append-only
   means rows accumulate. Propose: archive `done`/`failed` rows
   older than 90 days to a `processing_runs_archive` table. Decision
   needed before P0.
3. **`+billing` scope: who sees it in the Cloud Console UI?**
   Workspace owner only? All admins? Decision before P4-3.
4. **Quota tier mapping**: `skipped_quota` triggers when monthly
   tokens hit 0. Free tier: 0 LLM tokens (no Phase B at all)?
   Or 1K freebie tokens? Aligns to the ¥9.9 / ¥99 / $199 tiers.

---

## 9. Test strategy  *(updated)*

| Layer | Coverage |
|---|---|
| `canonicalize()` + `sha()` | Unit: 50+ cases (BOMs, CRLF, tabs, mixed indentation, fenced code, unicode, emoji, multilingual whitespace) |
| Doc dedup | Integration: 3× upload same content → 1 doc, 1 enrich job, dedup_hit=true on 2nd/3rd |
| Chunk dedup | Integration: doc A, doc B with 1 paragraph changed → expected blob count = N+1 (not 2N), refs distribution correct |
| Concurrent same-chunk | Integration: 10 parallel uploads of same content → 1 blob row, 10 ref rows (no race) |
| `processing_runs` dedup | Integration: queue same kind twice in parallel → second hits unique-violation, returns existing row |
| `processing_runs` force | Integration: queue → done → force=true → new row, revision=1, both visible in history query |
| Retry policy | Integration: failing executor → 3 retries with backoff → final `failed`, manual force=true clears |
| Wiki H2 splitter | Unit: 0/1/many H2; H2 in fenced code; setext H1/H2; indented "headings"; multilingual; trailing whitespace |
| Wiki Phase B incremental | Integration: edit one chapter → only that chapter re-summarizes, others have summary_sha unchanged |
| Quota | Integration: workspace at quota=0 → ai_enrich → status=skipped_quota, no LLM call |
| Rate limit | Integration: 70 docs/min upload from one workspace → first 60 succeed, last 10 get 429 |
| Auth: `documents:write` without `billing` | Integration: `force=true` returns 403; `force=false` succeeds. Toggle write to `auto_enrich_on_ingest=true` returns 403. |
| Auth: `documents:write` + `billing` | Integration: all of the above succeed. |
| `legacy_billing_enforcement=FALSE` | Integration: workspace owner flips toggle → audit row written; `documents:write` without `billing` can now `force=true` and write workspace settings. |
| `input_snapshot` reproducibility | Integration: enqueue ai_enrich → edit `workspace_tags` → run executes with the SNAPSHOT tag list, not the current one. Re-enqueue → fresh snapshot reflects the edit. |
| Backfill ↔ dual-write race | Integration: spawn 1 backfill loop + 5 concurrent writers for 60s on the same docs → assert no duplicate `chunk_refs` rows for any (doc, ord). |
| Backfill | Staging: load prod-size chunks snapshot, run script, assert `count(chunks) == count(chunk_refs)`. |
| `chunks_v` perf | Benchmark: vector / FTS / hybrid topK on prod-size data, regression ≤ 30%. |
| Migration safety | Staging: P0–P1 with dual-write running for 24h, assert `count(chunks_v rows) == count(chunks rows)` continuously. |

---

## 10. Telemetry  *(expanded — adds structured cost logs)*

### 10.1 Metrics (Prometheus)

- `processing_runs_started_total{kind}` counter
- `processing_runs_skipped_total{kind, reason}` counter
  (`reason ∈ {dedup, quota, rate_limit}`)
- `processing_runs_duration_seconds{kind, executor}` histogram
- `processing_runs_attempts_total{kind, attempt_no}` counter — surfaces retry storms
- `chunk_blobs_dedup_hit_ratio` — `chunks_reused / (chunks_reused + chunks_new)`, the headline ROI metric
- `documents_dedup_hit_total` counter
- `chunk_blobs_orphan_count` gauge — populated by the GC cron
- `wiki_chapters_summarize_total{result}` counter (`result ∈ {summarized, sha_unchanged}`)

### 10.2 Structured cost logs  *(pass 2 — currency-neutral)*

Every LLM call emits one structured log line:

```json
{
  "ts": "2026-04-28T...",
  "workspace_id": "...",
  "run_id": "...",
  "kind": "ai_enrich",
  "model": "gpt-4o-mini",
  "prompt_tokens": 1250,
  "completion_tokens": 320,
  "cost_usd_micros": 4180,
  "duration_ms": 2400
}
```

`cost_usd_micros` is integer USD micro-dollars (1 USD = 1_000_000).
Avoids float drift over millions of rows; multi-currency display
(¥, $, €) happens at the consumption layer (Cloud Console settings
page or finance export). Routed to a dedicated stream so a
per-workspace monthly cost report is one `SUM(cost_usd_micros)`
query.

### 10.3 Distributed trace

`processing_runs.id` propagates as `X-Run-Id` header to executor
HTTP calls (cloud_pool) and IPC payloads (mcp_pull). Trace
viewer joins `processing_runs` rows + executor LLM calls + cost
log entries on this id.

---

## 11. Implementation references

Current code that this design replaces or refactors:

- `cloud/api/app/routers/documents.py:_publish_document_created` —
  the entry-point being formalized
- `cloud/api/app/services/ingest/pipeline.py` — Phase A target
- `cloud/api/app/services/enrich/classifier.py` — refactored to
  read `chunk_refs` instead of re-chunking
- `cloud/api/app/services/enrich/dispatcher.py` — gains
  `processing_runs.executor` write
- `cloud/api/app/routers/enrich.py:_write_segments_done` — folds
  into `processors/note.py` Phase B
- `desktop/src/components/note/IngestDialog.tsx:buildCloudSteps` —
  reads `runs[]` instead of separate `ingest/enrich` fields
- `desktop/src/components/cloud-console/cards/EnrichJobsCard.tsx` —
  same; gains `force` button + `+billing` scope check

---

## 12. Out of scope (separate designs)

| Topic | Why deferred | Future doc |
|---|---|---|
| Memory shards (32KB byte-bounded) | Independent of dedup. Different problem (long-term memory store), different access pattern (write-heavy), different perf concerns (single-row hot lock). | `docs/memory-shards.md` (TBD) |
| Topology / KB graph walks | Builds on §2.4 entity_links extension but doesn't depend on it shipping today. UI for graph traversal is its own project. | `docs/kb-topology.md` (TBD) |
| Chapter `see_also` graph | Same as above; needs proper inverted-index algorithm (not naive O(N²)) and a worker process. | Folded into kb-topology doc |
| Note→memory distillation | Depends on memory shards. Per-workspace setting, default off. | Folded into memory-shards doc |
| Chunk-level FTS replacement of `text_search` table | If `chunk_blobs.fts` proves sufficient, retire the legacy table. Soak required first. | Post-P5 cleanup PR |

---

# Task plan  *(revised — 20 working days)*

Each phase is a working slice. Nothing half-built in main.

## Phase 0 — Foundations (~3-4 days, was 2)

Sets up dedup primitives. No behavior change visible to users.

| ID | Title | Files touched |
|---|---|---|
| P0-1 | Migration: `documents.content_sha256` plain column + trigger | `cloud/migrations/019_doc_dedup.sql` |
| P0-2 | Migration: `chunk_blobs` + `chunk_refs` + `chunks_v` view + GC cron skeleton | `cloud/migrations/020_chunk_dedup.sql`, `cloud/api/app/services/maintenance/blob_gc.py` |
| P0-3 | Migration: `processing_runs` (with `revision`, `triggered_by`) + `wiki_chapters` + `entity_links.source_kind` extension | `cloud/migrations/021_processing_runs.sql`, `022_wiki_chapters.sql` |
| P0-4 | `create_document` returns `dedup` field; conflict handling; quota hook scaffold | `cloud/api/app/routers/documents.py`, `desktop/src/lib/cloud-api.ts` |
| P0-5 | Backfill script for `documents.content_sha256` (chunked DO LOOP) + backfill script for `chunks → chunk_blobs/refs` (verified, not run yet) | `cloud/api/scripts/backfill_doc_sha.py`, `cloud/api/scripts/backfill_chunk_dedup.py` |
| P0-6 | `+billing` scope plumbing in `deps.py` (no UI yet, just scope check) | `cloud/api/app/deps.py` |

**Done = ** prod DB has new tables, all queries against legacy tables
unchanged. Re-uploading same content returns existing doc id with
`dedup.doc_hit=true`. CONCURRENTLY index built without write outage.

## Phase 1 — Chunk-level dedup (~3 days)

| ID | Title | Files touched |
|---|---|---|
| P1-1 | `services/knowledge/canonical.py` with `canonicalize()` + `sha()` + 50-case unit tests | new |
| P1-2 | `services/ingest/pipeline.py` writes both `chunks` and `chunk_blobs`/`chunk_refs`. Skip embedding when blob already has one. | `cloud/api/app/services/ingest/pipeline.py` |
| P1-3 | EXPLAIN ANALYZE gate: chunks_v vs chunks on prod-size data, three retrieval shapes, ≤ 30% regression budget. If exceeded → denormalize per §2.2 acceptance criteria. | benchmark notebook + decision memo |
| P1-4 | Search reads `chunks_v`. | `cloud/api/app/services/kb/hybrid.py` |
| P1-5 | Run `backfill_chunk_dedup.py` initial pass; verify counts. | ops |

**Done = ** uploading doc twice incurs zero re-embedding cost.
Telemetry shows `chunk_blobs_dedup_hit_ratio > 0` on a soak workspace.

## Phase 2a — Wiki Phase A (~3 days, was bundled into 4d P2)

| ID | Title | Files touched |
|---|---|---|
| P2a-1 | `services/processors/wiki.py` H2 splitter with full edge-case handling (fenced, setext, indent, CRLF, multilingual, no-H2 fallback) + 12+ unit tests | new |
| P2a-2 | Per-chapter chunking → `chunk_blobs`/`chunk_refs`; `wiki_chapters` insert | same |
| P2a-3 | Dispatcher in `DocumentCreated` handler routes by `smartnote_type` (note → existing path, wiki → wiki.process_a) | knowledge ctx event handler |

**Done = ** uploading a wiki populates `wiki_chapters` per H2,
chunks land deduped same as note path.

## Phase 2b — Wiki Phase B + UI (~3-4 days)

| ID | Title | Files touched |
|---|---|---|
| P2b-1 | Per-chapter LLM summarize + entity link via `entity_links(source_kind='wiki_chapter')`; `summary_sha` skip-if-unchanged | `services/processors/wiki.py` |
| P2b-2 | `POST /v1/processing/{doc_id}/run?kind=wiki_abstract` endpoint with `+billing` scope check on `force=true` | new router or extend `enrich.py` |
| P2b-3 | Cloud Console "Generate wiki abstract" + "Re-run" buttons | `desktop/src/components/cloud-console/cards/EnrichJobsCard.tsx` |
| P2b-4 | Desktop wiki source viewer renders abstract sheet at top | `desktop/src/components/wiki/WikiSourcesPanel.tsx` |

**Done = ** wiki abstract sheet visible end-to-end, incremental
re-summarization works (edit chapter → only that chapter re-LLMs).

## Phase 4 — Unified progress + console UX (~2-3 days)

| ID | Title | Files touched |
|---|---|---|
| P4-1 | `GET /v1/documents/{id}/pipeline` returns `runs[]` (legacy fields stay populated for one release). Run catch-up pass of `backfill_chunk_dedup.py`. | `cloud/api/app/routers/documents.py` |
| P4-2 | `IngestDialog.buildCloudSteps` reads `runs[]`, renders one PipelineStep per kind, `dedup` summary line ("4 new chunks · 12 reused") | `desktop/src/components/note/IngestDialog.tsx` |
| P4-3 | `EnrichJobsCard` reads same endpoint; "Re-run with force" button (gated by `+billing`); `skipped_dedup` / `skipped_quota` rows shown muted with distinct color | `desktop/src/components/cloud-console/cards/EnrichJobsCard.tsx` |
| P4-4 | Workspace settings UI for granting `+billing` scope per device | `desktop/src/components/cloud-console/tabs/DevicesTab.tsx` |
| P4-5 | AI CLI matches the new shape | cli surface |

**Done = ** all three clients show identical per-kind progress
including dedup/quota/force semantics. Re-entering any page reads
correct state from server with no client-state.

## Phase 5 — Cleanup (~1-2 days, gated on ≥ 1 release of soak)

| ID | Title | Files touched |
|---|---|---|
| P5-1 | Remove dual-write to `chunks` / `enrich_jobs` / `ingest_runs`. | `pipeline.py`, `enrich.py` |
| P5-2 | Drop legacy tables. Migration. | `cloud/migrations/024_drop_legacy.sql` |
| P5-3 | Retire `_schedule_auto_ingest` from `documents.py` and the `_publish_document_*` shims. | `cloud/api/app/routers/documents.py` |
| P5-4 | Update `docs/architecture.md` and `docs/retrieval.md` to reference this doc as single source of truth. | docs |

**Done = ** legacy tables gone, codebase has one path per operation.

## Sequencing and parallelism  *(updated)*

```
P0  ──────────────────────►  done
       ▲
       │  (P0 must complete first)
       │
P1  ───┼────────►  done
       │            ▲
P2a ───┼────────►   │
       │            │  (P1, P2a can ship in any order or in parallel)
P2b ───┼─►  needs P2a done
       │            │
       │            │
P4 ────┴────────────┘  (needs P0, P1, P2b)
       │
       ▼
P5 (after ≥ 1 release of soak)
```

**Total: 20 working days.** P1, P2a can run in parallel after P0;
P2b needs P2a; P4 needs P1+P2b merged.

---

## Appendix A: rejected alternatives  *(updated)*

- **Doc-level dedup only** (rejected per §1.3.1). Misses the wiki-
  edit case which is the dominant cost source.
- **Hash before strip** (rejected). Trailing-whitespace edits would
  invalidate dedup; users would see token costs they can't explain.
- **MD5 instead of SHA-256** (rejected). MD5 collisions are cheap; in
  a multi-tenant DB we don't want a malicious payload to alias into
  another user's chunk_blobs row.
- **Generated `content_sha256` column** (rejected after pass 1 review).
  Forces full table rewrite; INVALID/VALIDATE doesn't apply to
  generated columns. Replaced with trigger + chunked backfill +
  CONCURRENTLY index.
- **`chunk_blobs.ref_count` + delete trigger** (rejected after pass 1).
  Concurrent uploads race on EXCLUDED.ref_count, cascade deletes
  storm trigger, HNSW churns on `ref_count=0` deletes. Replaced
  with nightly orphan GC.
- **`force=true` deletes prior `processing_runs` row** (rejected
  after pass 1). Destroys audit chain. Replaced with `revision`
  bump → new row with new `input_sha`.
- **Hardcoded `VECTOR(1024)`** (rejected after pass 1). Production
  uses 384-dim today. Keep `dimension TEXT` discriminator pattern
  from existing `chunks` table.
- **`wiki_chapters.entity_ids UUID[]` alongside `entity_links`**
  (rejected after pass 1). Two sources of truth, guaranteed drift.
  Single source: `entity_links` with `source_kind='wiki_chapter'`.
- **Recursive H3/H4 wiki splitting** (rejected per §1.3.2).
  Diminishing returns; revisit in v1.3 behind a workspace flag.
- **Memory shards bundled with this design** (rejected after pass 1).
  Different problem (long-term memory store), different access
  pattern, different perf concerns. Now its own design.
- **Chapter `see_also` graph nightly job in v1.2** (rejected after
  pass 1). Naive algorithm is O(N²·E); needs proper inverted-index
  approach + worker process. Deferred to v1.3 with topology design.
- **Separate progress tables per kind** (rejected). The whole point
  of this design is one progress surface.
- **`embedding VECTOR` column without fixed dimension** (rejected
  after pass 2). pgvector's HNSW index requires a known dimension at
  CREATE INDEX time; `VECTOR` (no size) cannot back HNSW. Multi-
  embedder support, when needed, ships as table partitions
  (`chunk_blobs_384`, `chunk_blobs_1024`) routed by model name.
- **HNSW on a nullable embedding column without partial filter**
  (rejected after pass 2). HNSW cannot contain NULL rows; INSERT
  without embedding would error. Use `WHERE embedding IS NOT NULL`.
- **30-day `+billing` grandfather window** (rejected after pass 2).
  Two failure modes: (a) day 31 silent breakage of every existing
  agent integration; (b) for 30 days the protection is fully
  disabled for legacy keys, defeating the design. Replaced with
  per-workspace `legacy_billing_enforcement` toggle owned by the
  workspace owner.
- **Per-`kind` billing scope rules** (rejected after pass 2). The
  pass-1 scheme had `wiki_abstract` always require `+billing` while
  `ai_enrich force=false` did not — inconsistent and rotting as
  v1.3 adds workspace toggles for wiki_abstract too. Unified rule:
  `force=true` OR writing the auto-mode toggle requires `+billing`;
  passive auto-mode runs do not.
- **`triggered_by` as a single concatenated string** (rejected after
  pass 2). High-cardinality string column blocks SQL aggregations.
  Split into `trigger_kind` + `trigger_ref`.
- **`cost_cny` field on cost log** (rejected after pass 2). Bakes a
  single currency into the data plane. Replaced with currency-neutral
  `cost_usd_micros BIGINT`; UI converts at display time.

## Appendix B: glossary

- **Phase A**: cheap, deterministic, runs on every upload (chunk +
  embed + FTS).
- **Phase B**: expensive, LLM-driven, opt-in (enrich, wiki abstract).
- **Chunk blob**: deduplicated chunk content + embedding, keyed by
  `(workspace, content_sha)`.
- **Chunk ref**: pointer from a doc-position into a chunk blob.
- **Processing run**: one execution of one (kind, doc, input_sha,
  revision) tuple. Append-only.
- **Revision**: monotonic counter on `processing_runs` rows for the
  same (doc, kind). Bumped by force re-runs. Participates in
  `input_sha` so dedup naturally allows it.
- **`+billing` scope**: extends `documents:write` to permit force
  re-runs and any `kind` that always costs LLM tokens. Granted
  per-device by workspace owner.
