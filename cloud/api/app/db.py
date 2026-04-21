"""Postgres connection pool + migration runner.

asyncpg is used directly (no SQLAlchemy) — the schema is small and we want
the raw connection pool for low overhead. Migrations are SQL files under
`cloud/migrations/`; they run on startup in name order and are idempotent
(every CREATE uses IF NOT EXISTS).
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

import asyncpg

from app.config import get_settings

logger = logging.getLogger(__name__)

# SQLAlchemy-style URLs (postgresql+asyncpg://…) are ergonomic in docs but
# asyncpg itself only understands the plain scheme; strip the driver suffix
# so the two are interchangeable.
def _normalize_dsn(url: str) -> str:
    return url.replace("postgresql+asyncpg://", "postgresql://", 1)


_pool: asyncpg.Pool | None = None


async def _init_conn(conn: asyncpg.Connection) -> None:
    # asyncpg returns JSONB as raw text unless we register a codec. Decode
    # on read so handlers get dicts/lists; encode on write so we can pass
    # Python structures directly (caller still has the option of passing
    # a pre-serialized JSON string via the $N::jsonb cast pattern).
    await conn.set_type_codec(
        "jsonb",
        encoder=json.dumps,
        decoder=json.loads,
        schema="pg_catalog",
    )
    await conn.set_type_codec(
        "json",
        encoder=json.dumps,
        decoder=json.loads,
        schema="pg_catalog",
    )


async def init_pool() -> asyncpg.Pool:
    global _pool
    if _pool is not None:
        return _pool
    dsn = _normalize_dsn(get_settings().database_url)
    _pool = await asyncpg.create_pool(dsn, min_size=1, max_size=10, init=_init_conn)
    return _pool


async def close_pool() -> None:
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None


def pool() -> asyncpg.Pool:
    assert _pool is not None, "db pool not initialized — call init_pool() first"
    return _pool


def _locate_migrations_dir() -> Path:
    """Find cloud/migrations across both the Docker layout (/app/migrations)
    and the source-tree layout (cloud/migrations/). Falls back to the
    Docker path so error messages point at something real in prod."""
    here = Path(__file__).resolve()
    for candidate in (
        here.parents[1] / "migrations",   # /app/migrations (docker)
        here.parents[2] / "migrations",   # cloud/migrations (source tree)
    ):
        if candidate.exists():
            return candidate
    return here.parents[1] / "migrations"


MIGRATIONS_DIR = _locate_migrations_dir()


async def run_migrations() -> None:
    """Apply every .sql file in cloud/migrations/ in lexical order.

    No migration ledger is kept — every script must be IF NOT EXISTS safe.
    When the schema becomes too complex for this to hold, switch to a real
    migration tool (sqitch, alembic) — but at MVP scale the SQL is simple
    enough that pure idempotency is less moving parts than a ledger.
    """
    if not MIGRATIONS_DIR.exists():
        logger.warning("migrations dir not found: %s", MIGRATIONS_DIR)
        return
    files = sorted(MIGRATIONS_DIR.glob("*.sql"))
    if not files:
        logger.info("no migrations to run")
        return
    async with pool().acquire() as conn:
        for path in files:
            sql = path.read_text(encoding="utf-8")
            logger.info("running migration: %s", path.name)
            await conn.execute(sql)
    logger.info("migrations complete (%d files)", len(files))
