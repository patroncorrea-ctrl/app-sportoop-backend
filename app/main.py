import logging
import math
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from fastapi import Depends, FastAPI, HTTPException, Request, status
from fastapi.responses import JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from postgrest.exceptions import APIError
from pydantic import BaseModel, EmailStr, Field, field_validator
from supabase import Client

from app.constantes import STATUT_EN_ATTENTE, Nom
from app.db import get_supabase
from app.limites import ProtectionRequetes
from app.routes_coach import router as router_coach
from app.routes_nutrition import router as router_nutrition
from app.routes_sport import router as router_sport
from app.security import verifier_secret_webhook
from app.systemeio import router as router_systemeio

journal = logging.getLogger(__name__)

app = FastAPI(title="ADRM SPORTOOP API")
# Taille des corps et présence du jeton contrôlées AVANT toute lecture du corps
app.add_middleware(ProtectionRequetes)
app.include_router(router_nutrition)
app.include_router(router_sport)
app.include_router(router_systemeio)
app.include_router(router_coach)

# Frontend (application client sur /app/, espace coach sur /app/coach/), servi sur le même domaine que l'API
DOSSIER_WEB = Path(__file__).resolve().parent.parent / "web"
app.mount("/app", StaticFiles(directory=DOSSIER_WEB, html=True), name="web")


@app.exception_handler(APIError)
async def erreur_base_de_donnees(request: Request, exc: APIError) -> JSONResponse:
    """Erreur renvoyée par PostgREST : réponse JSON générique.

    Seul le code est journalisé : le détail (« Failing row contains (...) ») contient la ligne refusée,
    donc potentiellement des données de santé ou du journal alimentaire.
    """
    code = str(exc.code or "")
    journal.error("Erreur PostgREST %s sur %s %s", code or "?", request.method, request.url.path)
    if code == "23505":
        return JSONResponse({"detail": "Cette donnée existe déjà."}, status_code=status.HTTP_409_CONFLICT)
    if code.startswith(("22", "23")):  # valeur hors capacité, contrainte CHECK / NOT NULL / clé étrangère
        return JSONResponse({"detail": "Valeurs refusées par la base de données."},
                            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT)
    return JSONResponse({"detail": "Erreur de la base de données."}, status_code=500)


@app.get("/app", include_in_schema=False)
def app_sans_slash():
    return RedirectResponse("/app/")


@app.get("/")
def home():
    return {"status": "API en ligne", "system": "ADRM SPORTOOP"}


JoursSemaine = Literal["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi", "Dimanche"]

# Case de consentement telle que Make peut la transmettre (booléen, « Oui », libellé de la case cochée…)
CONSENTEMENT_OUI = {"true", "vrai", "oui", "yes", "y", "o", "1", "on", "x", "ok", "coche", "coché", "checked"}
CONSENTEMENT_NON = {"false", "faux", "non", "no", "n", "0", "off", "none", "null"}
DEBUTS_OUI = ("oui", "j'accepte", "j accepte", "jaccepte", "j'y consens", "je consens", "je donne mon accord",
              "je donne mon consentement", "accepte", "d'accord", "i agree", "i accept", "yes")
DEBUTS_NON = ("non", "je n", "je refuse", "refus", "no ", "i do not", "i don't")


def consentement_donne(valeur) -> bool:
    """Vrai seulement pour une acceptation explicite ; toute valeur vide, négative ou non reconnue vaut refus."""
    if isinstance(valeur, bool):
        return valeur
    if isinstance(valeur, (int, float)):
        return valeur == 1
    if isinstance(valeur, (list, tuple)):  # case à cocher Google Forms : liste des libellés cochés
        return any(consentement_donne(v) for v in valeur)
    if isinstance(valeur, str):
        texte = " ".join(valeur.replace("’", "'").lower().split())
        if not texte or texte in CONSENTEMENT_NON or texte.startswith(DEBUTS_NON):
            return False
        return texte in CONSENTEMENT_OUI or texte.startswith(DEBUTS_OUI)
    return False


def nombre_depuis_texte(valeur):
    """« 2 000 », « 2000,5 » ou « » (question facultative non répondue) tels que Make les transmet."""
    if isinstance(valeur, str):
        texte = re.sub(r"[\s  ]", "", valeur).replace(",", ".")
        if not texte:
            return None
        try:
            nombre = float(texte)
        except ValueError:
            return valeur  # laissé tel quel : refusé par la validation (422)
        return round(nombre) if math.isfinite(nombre) else valeur
    if isinstance(valeur, float) and math.isfinite(valeur):
        return round(valeur)
    return valeur


class ClientInput(BaseModel):
    """Réponses du formulaire d'onboarding (Google Forms → Make). Seuls nom et email sont obligatoires.

    Tolérant aux formats de Make : chaîne vide = question non répondue, nombres en texte,
    jours en texte ou en liste, consentement en booléen, « Oui » ou libellé de la case cochée.
    """

    nom: Nom
    email: EmailStr
    target_kcal: int | None = Field(default=None, ge=800, le=6000)
    target_proteines: int | None = Field(default=None, ge=0, le=500)
    target_glucides: int | None = Field(default=None, ge=0, le=1000)
    target_lipides: int | None = Field(default=None, ge=0, le=500)
    jours_sport: list[JoursSemaine] | None = Field(default=None, max_length=7)
    contraintes_sante: str | None = Field(default=None, max_length=5000)
    # Case « J'accepte que mes données de santé soient traitées… » (RGPD art. 9) : obligatoire pour les stocker
    consentement_sante: bool = False

    @field_validator("email")
    @classmethod
    def normaliser_email(cls, v: str) -> str:
        return v.strip().lower()

    @field_validator("target_kcal", "target_proteines", "target_glucides", "target_lipides", mode="before")
    @classmethod
    def objectifs_depuis_texte(cls, v):
        return nombre_depuis_texte(v)

    @field_validator("contraintes_sante", mode="before")
    @classmethod
    def contraintes_vides(cls, v):
        if isinstance(v, str):
            return v.strip() or None
        return v

    @field_validator("jours_sport", mode="before")
    @classmethod
    def jours_depuis_texte(cls, v):
        # Google Forms (cases à cocher) envoie souvent « Lundi, Mercredi » via Make, ou une liste
        if isinstance(v, str):
            v = re.split(r"[,;\n]", v)
        if isinstance(v, (list, tuple)):
            jours = [j.strip().capitalize() if isinstance(j, str) else j for j in v]
            jours = list(dict.fromkeys(j for j in jours if j != ""))
            return jours or None  # aucune case cochée : question non répondue, rien n'est remplacé
        return v

    @field_validator("consentement_sante", mode="before")
    @classmethod
    def consentement_depuis_make(cls, v) -> bool:
        return consentement_donne(v)


@app.post("/webhooks/nouveau-client", dependencies=[Depends(verifier_secret_webhook)])
def nouveau_client(data: ClientInput, supabase: Client = Depends(get_supabase)):
    """Formulaire d'onboarding, reçu UNE seule fois par e-mail.

    - E-mail inconnu : fiche créée « EN_ATTENTE » (aucun accès avant l'achat, qui la passe ACTIF).
    - Fiche existante sans formulaire (créée par la vente Systeme.io ou par le coach) : complétée, statut inchangé.
    - Formulaire déjà reçu : 409. Le formulaire ne prouve pas la propriété de l'e-mail ; ensuite seul le
      coach modifie la fiche (objectifs réglés, contraintes de santé, consentement).
    """
    champs = {"nom": data.nom}
    # Champs facultatifs : seulement ce qui a été répondu
    for champ in ("target_kcal", "target_proteines", "target_glucides", "target_lipides", "jours_sport"):
        valeur = getattr(data, champ)
        if valeur is not None:
            champs[champ] = valeur
    if data.contraintes_sante:
        if not data.consentement_sante:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT,
                "Données de santé reçues sans consentement explicite (case non cochée, ou valeur non reconnue : "
                "attendu « Oui », « true » ou le libellé « J'accepte… ») : elles ne peuvent pas être enregistrées.",
            )
        champs["contraintes_sante"] = data.contraintes_sante
    maintenant = datetime.now(timezone.utc).isoformat()
    if data.consentement_sante:
        champs["consentement_sante_le"] = maintenant
    champs["formulaire_recu_le"] = maintenant

    deja_recu = HTTPException(
        status.HTTP_409_CONFLICT,
        "Formulaire déjà reçu pour cet e-mail : seul le coach peut désormais modifier cette fiche.",
    )
    # Deux passages au plus : si la fiche est créée entre la lecture et l'insertion (vente Systeme.io
    # simultanée), l'insertion échoue sur l'unicité de l'e-mail et la fiche est alors complétée.
    for _ in range(2):
        table = supabase.table("clients")
        existant = table.select("id,formulaire_recu_le").eq("email", data.email).limit(1).execute().data
        if existant:
            if existant[0].get("formulaire_recu_le"):
                raise deja_recu
            # Condition répétée dans la mise à jour : deux envois simultanés ne complètent la fiche qu'une fois
            res = table.update(champs).eq("id", existant[0]["id"]).is_("formulaire_recu_le", "null").execute()
            if not res.data:
                raise deja_recu
            # Ne jamais renvoyer ni journaliser les données de santé
            return {"status": "success", "action": "fiche_completee", "client_id": existant[0]["id"]}
        try:
            res = table.insert({"email": data.email, "statut_abonnement": STATUT_EN_ATTENTE, **champs}).execute()
        except APIError as e:
            if e.code == "23505":
                continue
            raise
        return {"status": "success", "action": "fiche_creee",
                "client_id": res.data[0].get("id") if res.data else None}
    raise deja_recu
