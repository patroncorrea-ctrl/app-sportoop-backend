import os
from functools import lru_cache

from supabase import Client, create_client


@lru_cache
def get_supabase() -> Client:
    """Client Supabase unique, créé au premier appel (clé service_role, backend uniquement)."""
    url = os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_KEY")
    if not url or not key:
        raise RuntimeError("Variables SUPABASE_URL / SUPABASE_KEY non configurées.")
    return create_client(url, key)
