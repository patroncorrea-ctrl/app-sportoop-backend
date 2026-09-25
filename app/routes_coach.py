"""Actions réservées au coach qui nécessitent la clé service_role (le reste passe par Supabase + RLS)."""

import os
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, status
from supabase import Client

from app.auth import utilisateur_courant
from app.db import get_supabase

router = APIRouter(prefix="/coach", tags=["coach"])


def coach_courant(user_id: str = Depends(utilisateur_courant), supabase: Client = Depends(get_supabase)) -> str:
    lignes = supabase.table("coachs").select("user_id").eq("user_id", user_id).limit(1).execute().data
    if not lignes:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Accès réservé au coach.")
    return user_id


@router.post("/clients/{client_id}/invitation")
def inviter_client(
    client_id: UUID,
    request: Request,
    _coach: str = Depends(coach_courant),
    supabase: Client = Depends(get_supabase),
):
    """Crée le compte du client (e-mail d'invitation Supabase) et le rattache à sa fiche."""
    lignes = supabase.table("clients").select("id,email,user_id").eq("id", str(client_id)).limit(1).execute().data
    if not lignes:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Client introuvable.")
    client = lignes[0]
    if client.get("user_id"):
        raise HTTPException(status.HTTP_409_CONFLICT, "Ce client a déjà un compte.")

    # Page où le lien de l'e-mail renvoie le client pour choisir son mot de passe
    url_app = os.getenv("APP_URL") or str(request.base_url).rstrip("/")
    try:
        reponse = supabase.auth.admin.invite_user_by_email(
            client["email"], {"redirect_to": f"{url_app}/app/"}
        )
    except Exception:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "Invitation impossible : un compte existe peut-être déjà pour cet e-mail.",
        )
    supabase.table("clients").update({"user_id": reponse.user.id}).eq("id", client["id"]).execute()
    return {"status": "success", "email": client["email"]}
