"""Back-compat shim — moved to app.common.db in the modular-monolith refactor.

All callers should migrate to `from app.common.db import ...` over time.
This file re-exports so existing imports do not break in-flight.
"""

from app.common.db import *  # noqa: F401,F403
from app.common.db import (  # explicit re-exports for IDE / type-checker happiness
    close_pool,
    init_pool,
    pool,
    run_migrations,
)

__all__ = ["close_pool", "init_pool", "pool", "run_migrations"]
