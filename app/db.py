import logging
import os
from functools import lru_cache

from fastapi import HTTPException, status
from supabase import Client, create_client

journal = logging.getLogger(__name__)


@lru_cache
def get_supabase() -> Client:
    """Client Supabase unique, créé au premier appel (clé service_role, backend uniquement).

    Sans configuration : 503 JSON propre au lieu d'une erreur 500. Une exception n'est pas mise en cache
    par lru_cache : des variables ajoutées ensuite sont prises en compte.
    """
    url = os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_KEY")
    if not url or not key:
        journal.warning("Variables SUPABASE_URL / SUPABASE_KEY non configurées.")  # noms seulement, jamais de valeur
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Base de données non configurée.")
    return create_client(url, key)
