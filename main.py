import os
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from supabase import create_client, Client

# Récupération automatique des variables d'environnement Railway
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_KEY")

if not SUPABASE_URL or not SUPABASE_KEY:
    raise RuntimeError("Variables SUPABASE non configurées.")

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

app = FastAPI(title="ADRM SPORTOOP API")

@app.get("/")
def home():
    return {"status": "API en ligne", "system": "ADRM SPORTOOP"}

class ClientInput(BaseModel):
    nom: str
    email: str
    target_kcal: int = 1830

@app.post("/webhooks/nouveau-client")
def nouveau_client(data: ClientInput):
    res = supabase.table("clients").insert({
        "nom": data.nom,
        "email": data.email,
        "target_kcal": data.target_kcal
    }).execute()
    
    return {"status": "success", "client": res.data}