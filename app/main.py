from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from fastapi import Depends, FastAPI, HTTPException, status
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, EmailStr, Field, field_validator
from supabase import Client

from app.db import get_supabase
from app.routes_coach import router as router_coach
from app.routes_nutrition import router as router_nutrition
from app.routes_sport import router as router_sport
from app.security import verifier_secret_webhook
from app.systemeio import router as router_systemeio

app = FastAPI(title="ADRM SPORTOOP API")
app.include_router(router_nutrition)
app.include_router(router_sport)
app.include_router(router_systemeio)
app.include_router(router_coach)

# Frontend (application client sur /app/, espace coach sur /app/coach/), servi sur le même domaine que l'API
DOSSIER_WEB = Path(__file__).resolve().parent.parent / "web"
app.mount("/app", StaticFiles(directory=DOSSIER_WEB, html=True), name="web")


@app.get("/app", include_in_schema=False)
def app_sans_slash():
    return RedirectResponse("/app/")


@app.get("/")
def home():
    return {"status": "API en ligne", "system": "ADRM SPORTOOP"}


JoursSemaine = Literal["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi", "Dimanche"]


class ClientInput(BaseModel):
    """Réponses du formulaire d'onboarding (Google Forms → Make). Seuls nom et email sont obligatoires."""

    nom: str = Field(min_length=1, max_length=200)
    email: EmailStr
    target_kcal: int | None = Field(default=None, ge=800, le=6000)
    target_proteines: int | None = Field(default=None, ge=0, le=500)
    target_glucides: int | None = Field(default=None, ge=0, le=1000)
    target_lipides: int | None = Field(default=None, ge=0, le=500)
    jours_sport: list[JoursSemaine] | None = Field(default=None, max_length=7)
    contraintes_sante: str | None = Field(default=None, max_length=5000)
    # Case « J'accepte que mes données de santé soient traitées… » (RGPD art. 9) : obligatoire pour les stocker
    consentement_sante: bool = False

    @field_validator("nom")
    @classmethod
    def nettoyer_nom(cls, v: str) -> str:
        return v.strip()

    @field_validator("email")
    @classmethod
    def normaliser_email(cls, v: str) -> str:
        return v.strip().lower()

    @field_validator("jours_sport", mode="before")
    @classmethod
    def jours_depuis_texte(cls, v):
        # Google Forms (cases à cocher) envoie souvent « Lundi, Mercredi » via Make
        if isinstance(v, str):
            return [j.strip().capitalize() for j in v.replace(";", ",").split(",") if j.strip()]
        return v


@app.post("/webhooks/nouveau-client", dependencies=[Depends(verifier_secret_webhook)])
def nouveau_client(data: ClientInput, supabase: Client = Depends(get_supabase)):
    ligne = {"nom": data.nom, "email": data.email}
    # Champs facultatifs : on ne remplace les valeurs existantes que par ce qui a été répondu
    for champ in ("target_kcal", "target_proteines", "target_glucides", "target_lipides", "jours_sport"):
        valeur = getattr(data, champ)
        if valeur is not None:
            ligne[champ] = valeur
    contraintes = (data.contraintes_sante or "").strip()
    if contraintes:
        if not data.consentement_sante:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Données de santé reçues sans consentement explicite : elles ne peuvent pas être enregistrées.",
            )
        ligne["contraintes_sante"] = contraintes
    if data.consentement_sante:
        ligne["consentement_sante_le"] = datetime.now(timezone.utc).isoformat()

    # Upsert sur l'email : un client déjà existant est mis à jour au lieu de provoquer une erreur.
    res = supabase.table("clients").upsert(ligne, on_conflict="email").execute()
    # Ne jamais renvoyer ni journaliser les données de santé
    return {"status": "success", "client_id": res.data[0].get("id") if res.data else None}
