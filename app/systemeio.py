"""Webhook Systeme.io : nouvel achat (SALE_NEW) et résiliation / remboursement (SALE_CANCELED).

Signature (doc Systeme.io) : HMAC-SHA256 hexadécimal, avec le secret du webhook, du JSON « normalisé »
(sans espaces, Unicode échappé en \\uXXXX, « / » échappé en « \\/ », comme json_encode en PHP),
transmis dans le header X-Webhook-Signature. Le corps brut est vérifié d'abord (aucun parsing avant) ;
la normalisation n'est tentée qu'ensuite, sur un corps déjà borné en taille (middleware, 64 Ko).

Ordre des événements : abonnement_maj_le reçoit l'horodatage de l'événement (X-Webhook-Event-Timestamp,
identique à chaque nouvelle tentative de livraison). Un événement plus ancien que celui déjà appliqué
est ignoré (livraison tardive, rejeu).

Offres suivies : SYSTEMEIO_PRICE_PLAN_IDS (identifiants pricePlan.id séparés par des virgules).
Vide : toutes les ventes du compte comptent.
"""

import hashlib
import hmac
import json
import os
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from supabase import Client

from app.constantes import STATUT_ACTIF, STATUT_RESILIE
from app.db import get_supabase

router = APIRouter(tags=["webhooks"])


def normaliser(corps: bytes) -> bytes:
    objet = json.loads(corps)
    texte = json.dumps(objet, separators=(",", ":"), ensure_ascii=True)
    return texte.replace("/", "\\/").encode()


def _signature_de(corps: bytes, secret: str) -> str:
    return hmac.new(secret.encode(), corps, hashlib.sha256).hexdigest()


def signature_valide(corps: bytes, signature: str | None, secret: str) -> bool:
    if not signature:
        return False
    recue = signature.strip().lower()
    # 1) Corps brut, sans aucun parsing
    if hmac.compare_digest(_signature_de(corps, secret), recue):
        return True
    # 2) Corps normalisé comme json_encode (PHP) ; JSON invalide ou trop imbriqué : signature refusée
    try:
        normalise = normaliser(corps)
    except (ValueError, RecursionError):
        return False
    return hmac.compare_digest(_signature_de(normalise, secret), recue)


def lire_horodatage(valeur) -> datetime | None:
    """Horodatage ISO 8601 (ex. « 2024-04-09T12:17:40+00:00 ») en datetime UTC, ou None."""
    if not valeur:
        return None
    try:
        moment = datetime.fromisoformat(str(valeur).strip())
    except ValueError:
        return None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment.astimezone(timezone.utc)


def offres_suivies() -> set[str]:
    return {i.strip() for i in os.getenv("SYSTEMEIO_PRICE_PLAN_IDS", "").split(",") if i.strip()}


def nom_du_client(customer: dict) -> str:
    champs = customer.get("fields") or {}
    nom = " ".join(p for p in (champs.get("first_name"), champs.get("surname")) if p).strip()
    return nom or customer["email"].split("@")[0]


async def corps_signe(
    request: Request,
    x_webhook_signature: str | None = Header(default=None),
) -> bytes:
    """Corps de la requête, seulement si la signature est valide (vérifiée avant l'accès à la base)."""
    secret = os.getenv("SYSTEMEIO_WEBHOOK_SECRET")
    if not secret:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Webhook non configuré.")
    corps = await request.body()
    if not signature_valide(corps, x_webhook_signature, secret):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Signature invalide.")
    return corps


@router.post("/webhooks/systemeio")
def webhook_systemeio(
    corps: bytes = Depends(corps_signe),
    x_webhook_event: str | None = Header(default=None),
    x_webhook_event_timestamp: str | None = Header(default=None),
    supabase: Client = Depends(get_supabase),
):
    if x_webhook_event not in ("SALE_NEW", "SALE_CANCELED"):
        return {"status": "ignore"}  # autres événements : accusé de réception sans traitement

    try:
        donnees = json.loads(corps)
    except (ValueError, RecursionError):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Corps JSON invalide.")
    if not isinstance(donnees, dict):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Corps JSON invalide.")
    customer = donnees.get("customer") if isinstance(donnees.get("customer"), dict) else {}
    email = str(customer.get("email") or "").strip().lower()
    if not email:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Email client absent.")

    # Seules les offres de coaching modifient l'accès (un ebook ou un order bump ne compte pas)
    suivies = offres_suivies()
    if suivies:
        plan = donnees.get("pricePlan") if isinstance(donnees.get("pricePlan"), dict) else {}
        if str(plan.get("id") or "").strip() not in suivies:
            return {"status": "ignore", "raison": "offre non suivie"}

    maintenant = datetime.now(timezone.utc)
    moment = lire_horodatage(x_webhook_event_timestamp) or maintenant
    # L'en-tête n'est pas couvert par la signature : un horodatage dans le futur bloquerait les vrais événements suivants
    moment = min(moment, maintenant)
    table = supabase.table("clients")
    existant = table.select("id,abonnement_maj_le").eq("email", email).limit(1).execute().data
    if existant:
        deja_applique = lire_horodatage(existant[0].get("abonnement_maj_le"))
        if deja_applique and moment < deja_applique:
            return {"status": "ignore", "raison": "événement plus ancien que le dernier appliqué"}

    if x_webhook_event == "SALE_NEW":
        champs = {"statut_abonnement": STATUT_ACTIF, "abonnement_maj_le": moment.isoformat(),
                  "systemeio_contact_id": customer.get("contactId")}
        if existant:
            table.update(champs).eq("id", existant[0]["id"]).execute()  # le nom saisi au formulaire est conservé
        else:
            table.insert({"email": email, "nom": nom_du_client({**customer, "email": email}), **champs}).execute()
        return {"status": "success", "action": "abonnement_actif"}

    # SALE_CANCELED : abonnement résilié ou paiement unique remboursé
    if not existant:
        return {"status": "ignore", "raison": "client inconnu"}
    table.update({"statut_abonnement": STATUT_RESILIE, "abonnement_maj_le": moment.isoformat()}).eq(
        "id", existant[0]["id"]).execute()
    return {"status": "success", "action": "abonnement_resilie"}
