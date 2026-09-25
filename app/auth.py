from fastapi import Depends, Header, HTTPException, status
from supabase import Client
from supabase_auth.errors import AuthApiError, AuthInvalidJwtError, AuthSessionMissingError

from app.constantes import STATUT_ACTIF, STATUT_EN_ATTENTE, STATUT_RESILIE
from app.db import get_supabase
from app.depot import DepotNutrition, get_depot

# Motif du refus selon le statut (le frontend lit « attente » / « résilié » dans le message)
MOTIFS_REFUS = {
    STATUT_EN_ATTENTE: "Abonnement en attente d'activation.",
    STATUT_RESILIE: "Abonnement résilié.",
}


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
    except (AuthInvalidJwtError, AuthSessionMissingError):
        reponse = None
    except AuthApiError as e:
        if e.status not in (400, 401, 403, 404):
            # Supabase en panne ou saturé : ce n'est pas le jeton qui est en cause, le client ne doit pas être déconnecté
            raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Service d'authentification indisponible.")
        reponse = None
    except Exception:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Service d'authentification indisponible.")
    if not reponse or not reponse.user:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Jeton d'authentification invalide.")
    return reponse.user.id


def client_courant(
    user_id: str = Depends(utilisateur_courant),
    depot: DepotNutrition = Depends(get_depot),
) -> dict:
    """Fiche client liée au compte connecté : 403 sans fiche, ou si l'abonnement n'est pas ACTIF."""
    client = depot.client_par_user_id(user_id)
    if not client:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Aucune fiche client liée à ce compte.")
    statut = client.get("statut_abonnement")
    if statut != STATUT_ACTIF:
        raise HTTPException(status.HTTP_403_FORBIDDEN, MOTIFS_REFUS.get(statut, "Abonnement inactif."))
    return client
