"""Webhook Systeme.io : nouvel achat (SALE_NEW) et résiliation / remboursement (SALE_CANCELED).

Signature (doc Systeme.io) : HMAC-SHA256 hexadécimal, avec le secret du webhook, du JSON « normalisé »
(sans espaces, Unicode échappé en \\uXXXX, « / » échappé en « \\/ », comme json_encode en PHP),
transmis dans le header X-Webhook-Signature. Le corps brut est aussi accepté s'il est déjà sous cette forme.
"""

import hashlib
import hmac
import json
import os
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from supabase import Client

from app.db import get_supabase

router = APIRouter(tags=["webhooks"])


def normaliser(corps: bytes) -> bytes:
    objet = json.loads(corps)
    texte = json.dumps(objet, separators=(",", ":"), ensure_ascii=True)
    return texte.replace("/", "\\/").encode()


def signature_valide(corps: bytes, signature: str | None, secret: str) -> bool:
    if not signature:
        return False
    candidats = [corps]
    try:
        candidats.append(normaliser(corps))
    except ValueError:
        return False
    for c in candidats:
        attendu = hmac.new(secret.encode(), c, hashlib.sha256).hexdigest()
        if hmac.compare_digest(attendu, signature.strip().lower()):
            return True
    return False


def nom_du_client(customer: dict) -> str:
    champs = customer.get("fields") or {}
    nom = " ".join(p for p in (champs.get("first_name"), champs.get("surname")) if p).strip()
    return nom or customer["email"].split("@")[0]


@router.post("/webhooks/systemeio")
async def webhook_systemeio(
    request: Request,
    x_webhook_event: str | None = Header(default=None),
    x_webhook_signature: str | None = Header(default=None),
    supabase: Client = Depends(get_supabase),
):
    secret = os.getenv("SYSTEMEIO_WEBHOOK_SECRET")
    if not secret:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Webhook non configuré.")
    corps = await request.body()
    if not signature_valide(corps, x_webhook_signature, secret):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Signature invalide.")

    if x_webhook_event not in ("SALE_NEW", "SALE_CANCELED"):
        return {"status": "ignore"}  # autres événements : accusé de réception sans traitement

    donnees = json.loads(corps)
    customer = donnees.get("customer") or {}
    email = (customer.get("email") or "").strip().lower()
    if not email:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Email client absent.")

    maintenant = datetime.now(timezone.utc).isoformat()
    table = supabase.table("clients")
    existant = table.select("id").eq("email", email).limit(1).execute().data

    if x_webhook_event == "SALE_NEW":
        champs = {"statut_abonnement": "ACTIF", "abonnement_maj_le": maintenant,
                  "systemeio_contact_id": customer.get("contactId")}
        if existant:
            table.update(champs).eq("id", existant[0]["id"]).execute()  # le nom saisi au formulaire est conservé
        else:
            table.insert({"email": email, "nom": nom_du_client({**customer, "email": email}), **champs}).execute()
        return {"status": "success", "action": "abonnement_actif"}

    # SALE_CANCELED : abonnement résilié ou paiement unique remboursé
    if not existant:
        return {"status": "ignore", "raison": "client inconnu"}
    table.update({"statut_abonnement": "RESILIE", "abonnement_maj_le": maintenant}).eq(
        "id", existant[0]["id"]).execute()
    return {"status": "success", "action": "abonnement_resilie"}
