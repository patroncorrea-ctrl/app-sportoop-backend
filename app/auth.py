from fastapi import Depends, Header, HTTPException, status
from supabase import Client

from app.db import get_supabase
from app.depot import DepotNutrition, get_depot


def utilisateur_courant(
    authorization: str | None = Header(default=None),
    supabase: Client = Depends(get_supabase),
) -> str:
    """Vérifie le jeton Supabase Auth (header « Authorization: Bearer <jwt> ») et renvoie l'id utilisateur."""
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Jeton d'authentification manquant.")
    jeton = authorization[7:].strip()
    try:
        reponse = supabase.auth.get_user(jeton)
    except Exception:
        reponse = None
    if not reponse or not reponse.user:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Jeton d'authentification invalide.")
    return reponse.user.id


def client_courant(
    user_id: str = Depends(utilisateur_courant),
    depot: DepotNutrition = Depends(get_depot),
) -> dict:
    """Fiche client liée au compte connecté (403 si le compte n'est rattaché à aucun client)."""
    client = depot.client_par_user_id(user_id)
    if not client:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Aucune fiche client liée à ce compte.")
    if client.get("statut_abonnement") == "RESILIE":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Abonnement résilié.")
    return client
