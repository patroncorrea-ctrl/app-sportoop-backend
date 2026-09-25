"""Actions réservées au coach qui nécessitent la clé service_role (le reste passe par Supabase + RLS)."""

import logging
import os
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from supabase import Client
from supabase_auth.errors import AuthApiError, AuthError

from app.auth import utilisateur_courant
from app.db import get_supabase

router = APIRouter(prefix="/coach", tags=["coach"])
journal = logging.getLogger(__name__)

# Recherche d'un compte existant par e-mail : taille des pages de l'API admin, et plafond de sécurité
COMPTES_PAR_PAGE = 200
PAGES_MAX = 50

CODES_EMAIL_PRIS = {"email_exists", "user_already_exists"}
CODES_LIMITE_ENVOI = {"over_email_send_rate_limit", "over_request_rate_limit"}
MESSAGE_EMAIL_PRIS = (
    "Un autre compte de connexion utilise déjà cet e-mail. Par sécurité, il n'est pas rattaché automatiquement "
    "à cette fiche : vérifiez-le dans Supabase (Authentication → Users), supprimez-le s'il n'est pas légitime, "
    "puis renvoyez l'invitation."
)


def coach_courant(user_id: str = Depends(utilisateur_courant), supabase: Client = Depends(get_supabase)) -> str:
    if not est_coach(supabase, user_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Accès réservé au coach.")
    return user_id


def est_coach(supabase: Client, user_id: str) -> bool:
    return bool(supabase.table("coachs").select("user_id").eq("user_id", user_id).limit(1).execute().data)


def url_application(request: Request) -> str:
    """Adresse publique de l'application, sans « / » final.

    APP_URL si elle est définie ; sinon l'hôte de la requête, en https si le proxy (Railway) l'indique
    par X-Forwarded-Proto (uvicorn ignore cet en-tête par défaut et verrait du http).
    """
    configuree = (os.getenv("APP_URL") or "").strip()
    if configuree:
        return configuree.rstrip("/")
    url = request.base_url
    proto = request.headers.get("x-forwarded-proto", "").split(",")[0].strip().lower()
    if proto in ("http", "https"):
        url = url.replace(scheme=proto)
    return str(url).rstrip("/")


def lire_fiche(supabase: Client, client_id: UUID) -> dict:
    lignes = supabase.table("clients").select("id,email,user_id").eq("id", str(client_id)).limit(1).execute().data
    if not lignes:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Client introuvable.")
    return lignes[0]


def compte_par_email(supabase: Client, email: str):
    """Compte Supabase Auth portant cet e-mail (API admin, parcours paginé), ou None."""
    cible = email.strip().lower()
    for page in range(1, PAGES_MAX + 1):
        comptes = supabase.auth.admin.list_users(page=page, per_page=COMPTES_PAR_PAGE)
        for compte in comptes:
            if (compte.email or "").strip().lower() == cible:
                return compte
        if len(comptes) < COMPTES_PAR_PAGE:
            return None
    return None


def refus_envoi(e: Exception) -> HTTPException:
    """Traduit un refus de Supabase Auth lors de l'envoi d'un e-mail (jamais l'adresse dans les journaux)."""
    code = getattr(e, "code", None)
    statut = getattr(e, "status", None)
    journal.warning("Envoi d'e-mail refusé par Supabase Auth (code=%s, statut=%s)", code, statut)
    if code == "email_address_not_authorized":
        detail = ("L'envoi de l'e-mail a été refusé par Supabase : configurez un serveur SMTP personnalisé "
                  "(Authentication → SMTP Settings). Sans lui, Supabase n'envoie qu'aux membres de l'équipe du projet.")
    elif code in CODES_LIMITE_ENVOI or statut == 429:
        detail = ("L'envoi de l'e-mail a été refusé par Supabase : limite d'envoi atteinte. Réessayez plus tard, "
                  "ou configurez un serveur SMTP personnalisé (Authentication → SMTP Settings) pour relever la limite.")
    elif isinstance(e, AuthError):
        detail = ("L'envoi de l'e-mail a été refusé par Supabase : configurez un serveur SMTP personnalisé "
                  "(Authentication → SMTP Settings) et vérifiez les réglages d'authentification (Site URL, Redirect URLs).")
    else:
        detail = "Supabase Auth ne répond pas : réessayez dans quelques instants."
    return HTTPException(status.HTTP_502_BAD_GATEWAY, detail)


@router.post("/clients/{client_id}/invitation")
def inviter_client(
    client_id: UUID,
    request: Request,
    _coach: str = Depends(coach_courant),
    supabase: Client = Depends(get_supabase),
):
    """Donne accès au client par e-mail.

    - Fiche sans compte : invitation Supabase (création du compte), puis rattachement à la fiche.
    - Compte déjà rattaché (invitation expirée, perdue, mot de passe oublié) : lien de connexion permettant
      de choisir un mot de passe (réinitialisation Supabase).
    """
    fiche = lire_fiche(supabase, client_id)
    # Page où le lien de l'e-mail renvoie le client pour choisir son mot de passe
    options = {"redirect_to": f"{url_application(request)}/app/"}

    if fiche.get("user_id"):
        email = fiche["email"]
        try:
            compte = supabase.auth.admin.get_user_by_id(fiche["user_id"])
            email = (compte.user.email if compte and compte.user else None) or email
        except Exception:
            pass  # à défaut, l'e-mail de la fiche
        try:
            supabase.auth.reset_password_for_email(email, options)
        except Exception as e:
            raise refus_envoi(e) from e
        return {"status": "success", "action": "lien_connexion", "email": email}

    email = fiche["email"]
    try:
        existant = compte_par_email(supabase, email)
    except Exception:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY,
                            "Supabase Auth ne répond pas (recherche des comptes existants) : réessayez.")
    if existant:
        # Compte créé hors invitation (ex. inscription publique) : son mot de passe n'est pas maîtrisé,
        # le rattacher donnerait accès à la fiche (données de santé) à celui qui l'a créé.
        raise HTTPException(status.HTTP_409_CONFLICT, MESSAGE_EMAIL_PRIS)
    try:
        reponse = supabase.auth.admin.invite_user_by_email(email, options)
    except AuthApiError as e:
        if e.code in CODES_EMAIL_PRIS:
            raise HTTPException(status.HTTP_409_CONFLICT, MESSAGE_EMAIL_PRIS)
        raise refus_envoi(e) from e
    except Exception as e:
        raise refus_envoi(e) from e
    supabase.table("clients").update({"user_id": reponse.user.id}).eq("id", fiche["id"]).execute()
    return {"status": "success", "action": "invitation", "email": email}


def compte_a_effacer(supabase: Client, fiche: dict) -> str | None:
    """Compte de connexion à supprimer avec la fiche, ou None.

    - Compte rattaché (user_id) : celui-là.
    - Fiche sans compte rattaché : compte Auth portant son e-mail, s'il n'est rattaché à aucune autre fiche
      (invitation créée mais rattachement échoué, inscription faite hors invitation). Il ne donne accès à rien
      mais conserve l'e-mail de la personne : l'effacement doit l'emporter aussi.
    Un compte coach (essai du coach sur son propre compte) n'est jamais supprimé.
    """
    user_id = fiche.get("user_id")
    if not user_id:
        try:
            compte = compte_par_email(supabase, fiche["email"])
        except Exception:
            raise HTTPException(status.HTTP_502_BAD_GATEWAY,
                                "Supabase Auth ne répond pas (recherche du compte de connexion) : "
                                "rien n'a été effacé, réessayez.")
        if not compte:
            return None
        autre_fiche = supabase.table("clients").select("id").eq("user_id", compte.id).limit(1).execute().data
        if autre_fiche:
            return None
        user_id = compte.id
    return None if est_coach(supabase, user_id) else user_id


@router.delete("/clients/{client_id}", status_code=status.HTTP_204_NO_CONTENT)
def supprimer_client(
    client_id: UUID,
    _coach: str = Depends(coach_courant),
    supabase: Client = Depends(get_supabase),
):
    """Droit à l'effacement (RGPD) : supprime le compte de connexion de la personne (voir compte_a_effacer)
    puis la fiche et, en cascade, toutes ses données (journal, aliments, séances, historique, règles, boutons).

    Le compte est supprimé en premier : en cas d'échec, rien n'est effacé et la demande peut être refaite."""
    fiche = lire_fiche(supabase, client_id)
    user_id = compte_a_effacer(supabase, fiche)
    if user_id:
        try:
            supabase.auth.admin.delete_user(user_id)
        except AuthApiError as e:
            if e.status != 404 and e.code != "user_not_found":
                journal.warning("Suppression du compte refusée par Supabase Auth (code=%s)", e.code)
                raise HTTPException(status.HTTP_502_BAD_GATEWAY,
                                    "Suppression du compte de connexion refusée par Supabase : rien n'a été effacé.")
        except Exception:
            raise HTTPException(status.HTTP_502_BAD_GATEWAY,
                                "Supabase Auth ne répond pas : rien n'a été effacé, réessayez.")
    supabase.table("clients").delete().eq("id", fiche["id"]).execute()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
