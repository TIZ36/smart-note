"""Back-compat shim — moved to app.services.account.supabase."""

from app.services.account.supabase import (  # noqa: F401
    SupabaseUser,
    current_supabase_user,
)

__all__ = ["SupabaseUser", "current_supabase_user"]
