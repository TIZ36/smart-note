"""One-shot backfill for `documents.content_sha256`.

Migration 019 adds the column nullable + a trigger for new rows; this
script walks existing rows in chunks and populates them.

Why a separate script (not in the migration):
- The migration runner uses an implicit transaction; a chunked UPDATE
  loop with sleeps must run outside that.
- It can be re-run safely; the WHERE clause matches only NULL rows.
- It can run live alongside writes — `documents_dedup` (the unique
  index) gets created in the migration, so any duplicate-content
  rows that already exist will fail the index build, surfacing the
  data issue before this script runs. The script will then skip them
  by clause (UPDATE ... WHERE content_sha256 IS NULL hits the same
  rows on re-run; resolve duplicates by hand or with a separate cleanup).

Run cadence:
  - P0-5: write + verify (this file lands)
  - P0 deploy: run once on staging, benchmark wall time
  - Production: run during a maintenance window or off-peak —
    each loop holds row locks briefly; sleeps keep the table cool.

Usage:
  DATABASE_URL=postgresql://... python -m scripts.backfill_doc_sha
"""

from __future__ import annotations

import asyncio
import logging
import os
import sys
import time

import asyncpg

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s: %(message)s")
log = logging.getLogger("backfill_doc_sha")

BATCH = 5_000          # rows per UPDATE; keeps each transaction short
SLEEP_S = 0.05         # cooling between batches; ~no impact under low write load


async def main() -> int:
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        log.error("DATABASE_URL not set")
        return 2
    # asyncpg expects `postgresql://` (or `postgres://`); strip the
    # SQLAlchemy `+asyncpg` driver suffix the API uses.
    dsn = dsn.replace("postgresql+asyncpg://", "postgresql://", 1)

    conn = await asyncpg.connect(dsn=dsn)
    try:
        total = 0
        started = time.monotonic()
        while True:
            # `pgcrypto.digest()` runs server-side so we don't ship
            # content over the wire just to hash it. The IN-with-LIMIT
            # subselect avoids the dreaded `UPDATE ... LIMIT` (Postgres
            # doesn't support that directly).
            result = await conn.execute("""
                UPDATE documents SET content_sha256 = encode(digest(content,'sha256'),'hex')
                WHERE id IN (
                  SELECT id FROM documents
                  WHERE content_sha256 IS NULL
                  ORDER BY id
                  LIMIT $1
                )
            """, BATCH)
            n = int(result.split()[-1]) if result.startswith("UPDATE") else 0
            total += n
            if n == 0:
                break
            elapsed = time.monotonic() - started
            log.info("backfilled %d so far (this batch %d, %.1fs elapsed)", total, n, elapsed)
            await asyncio.sleep(SLEEP_S)
        log.info("done. total=%d rows updated in %.1fs", total, time.monotonic() - started)
        return 0
    finally:
        await conn.close()


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
