# cloud/api/scripts/

Maintenance scripts. Each one is a standalone Python entry-point that
takes `DATABASE_URL` from the environment.

| Script | Purpose | Idempotent | Live-safe |
|---|---|---|---|
| `backfill_doc_sha.py` | Populate `documents.content_sha256` for rows that predate migration 019. | yes (`WHERE content_sha256 IS NULL`) | yes |
| `backfill_chunk_dedup.py` | Copy legacy `chunks` rows into the new `chunk_blobs` + `chunk_refs` tables. | yes (`ON CONFLICT DO NOTHING` on both inserts) | yes (relies on the unique indexes from migration 020) |

Both scripts accept the SQLAlchemy-shaped DSN the API uses
(`postgresql+asyncpg://...`); the `+asyncpg` suffix is stripped
internally so plain asyncpg can connect.

## When to run

- **Right after migration 019 lands**: run `backfill_doc_sha.py`. The
  trigger keeps new rows populated; this fills in the existing rows.
  Until it finishes, dedup at the doc layer still works for *new*
  uploads but won't catch a re-upload of pre-migration content.

- **Right after migration 020 lands AND P1-2 starts dual-writing**:
  run `backfill_chunk_dedup.py` initial pass. Search reads still hit
  the legacy `chunks` table during P1, so a slow backfill doesn't
  block users.

- **Before the P4 cutover** (when search reads flip to `chunks_v`):
  run `backfill_chunk_dedup.py` again as a catch-up sweep — picks
  up anything new nodes wrote during the rolling deploy that the
  initial pass missed.

## Run

```bash
cd cloud/api
DATABASE_URL=postgresql://user:pass@host:5432/smartnote \
  python -m scripts.backfill_doc_sha

DATABASE_URL=postgresql://user:pass@host:5432/smartnote \
  python -m scripts.backfill_chunk_dedup
```

## Wall time

- `backfill_doc_sha.py` — server-side `digest()` + 5000-row batches
  + 50ms sleep. Roughly N/100k rows = ~1 minute on a stock t3.medium.
- `backfill_chunk_dedup.py` — slower (per-row Python work + 2 inserts
  + canonicalize). Benchmark on staging before prod; record the
  number in the deploy runbook.

Both scripts log progress every batch:

```
2026-04-28 14:23:01 INFO: backfilled 5000 so far (this batch 5000, 0.4s elapsed)
2026-04-28 14:23:01 INFO: backfilled 10000 so far (this batch 5000, 0.7s elapsed)
...
```

## Safety

- **`backfill_doc_sha.py`** can run continuously; row-level locks are
  held only while a single batch UPDATE executes.
- **`backfill_chunk_dedup.py`** can run alongside the live ingest
  pipeline because both writer paths use `ON CONFLICT DO NOTHING`.
  The unique index `chunk_refs_doc_ord` (migration 020) is what makes
  this safe — without it, a backfill row racing a live row would
  produce two refs for the same `(doc, ord)`.

If a script is killed mid-run, restart — it picks up where it left
off via the `WHERE NOT EXISTS` / `WHERE NULL` guard in its select.
