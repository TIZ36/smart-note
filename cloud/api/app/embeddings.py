"""Back-compat shim — moved to app.services.embedding.client in the
modular-monolith refactor. Re-exports preserved so existing callers keep
working until migrated.
"""

from app.services.embedding.client import (  # noqa: F401
    embed_one,
    embed_texts,
    format_vector_literal,
)

__all__ = ["embed_one", "embed_texts", "format_vector_literal"]
