from pathlib import Path

from fastapi import Depends, FastAPI
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


class ClientInput(BaseModel):
    nom: str = Field(min_length=1, max_length=200)
    email: EmailStr
    target_kcal: int = Field(default=1830, ge=800, le=6000)

    @field_validator("nom")
    @classmethod
    def nettoyer_nom(cls, v: str) -> str:
        return v.strip()

    @field_validator("email")
    @classmethod
    def normaliser_email(cls, v: str) -> str:
        return v.strip().lower()


@app.post("/webhooks/nouveau-client", dependencies=[Depends(verifier_secret_webhook)])
def nouveau_client(data: ClientInput, supabase: Client = Depends(get_supabase)):
    # Upsert sur l'email : un client déjà existant est mis à jour au lieu de provoquer une erreur.
    res = (
        supabase.table("clients")
        .upsert(
            {"nom": data.nom, "email": data.email, "target_kcal": data.target_kcal},
            on_conflict="email",
        )
        .execute()
    )
    return {"status": "success", "client": res.data}
