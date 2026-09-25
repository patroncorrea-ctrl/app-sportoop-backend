from datetime import date, datetime
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Response, status
from pydantic import BaseModel, Field, model_validator

from app import openfoodfacts
from app.auth import client_courant
from app.constantes import FUSEAU, TYPES_REPAS, TypeRepas
from app.depot import DepotNutrition, get_depot

router = APIRouter(tags=["nutrition"])

MACROS = ("proteines", "glucides", "lipides")


def aujourdhui() -> date:
    return datetime.now(FUSEAU).date()


def _totaux(aliments: list[dict]) -> dict:
    return {
        "kcal": int(sum(a.get("kcal") or 0 for a in aliments)),
        **{m: round(sum(float(a.get(m) or 0) for a in aliments), 1) for m in MACROS},
    }


# ---------------------------------------------------------------------------
# Journal du jour
# ---------------------------------------------------------------------------
@router.get("/journal")
def journal_du_jour(
    jour: date | None = Query(default=None, alias="date"),
    client: dict = Depends(client_courant),
    depot: DepotNutrition = Depends(get_depot),
):
    """Les 8 blocs repas du jour (vides compris), les totaux et le restant par rapport aux objectifs."""
    jour = jour or aujourdhui()
    existants = {r["type_repas"]: r for r in depot.repas_du_jour(client["id"], jour)}

    blocs = []
    for type_repas in TYPES_REPAS:
        r = existants.get(type_repas, {})
        aliments = sorted(r.get("aliments", []), key=lambda a: a.get("created_at") or "")
        blocs.append({
            "type_repas": type_repas,
            "repas_id": r.get("id"),
            "target_kcal": r.get("target_kcal") or 0,
            "consigne_coach": r.get("consigne_coach"),
            "aliments": aliments,
            "totaux": _totaux(aliments),
        })

    objectifs = {
        "kcal": client.get("target_kcal") or 0,
        "proteines": client.get("target_proteines") or 0,
        "glucides": client.get("target_glucides") or 0,
        "lipides": client.get("target_lipides") or 0,
    }
    totaux = _totaux([a for b in blocs for a in b["aliments"]])
    restant = {k: round(objectifs[k] - totaux[k], 1) for k in objectifs}
    restant["kcal"] = int(restant["kcal"])
    return {"date": jour.isoformat(), "objectifs": objectifs, "totaux": totaux, "restant": restant, "repas": blocs}


# ---------------------------------------------------------------------------
# Open Food Facts
# ---------------------------------------------------------------------------
@router.get("/produits/{code_barres}")
def produit_par_code_barres(
    code_barres: str = Path(pattern=r"^\d{8,14}$"),
    _client: dict = Depends(client_courant),
):
    """Valeurs nutritionnelles pour 100 g d'un produit (Open Food Facts)."""
    try:
        return openfoodfacts.chercher_produit(code_barres)
    except openfoodfacts.ProduitIntrouvable:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Produit introuvable dans Open Food Facts.")
    except openfoodfacts.ServiceIndisponible:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, "Open Food Facts ne répond pas, réessayez.")


# ---------------------------------------------------------------------------
# Aliments
# ---------------------------------------------------------------------------
class AlimentAjout(BaseModel):
    """Valeurs données pour 100 g (base « 100g », quantite_g obligatoire) ou pour la portion entière."""

    nom_aliment: str = Field(min_length=1, max_length=200)
    methode_ajout: Literal["scan_barcode", "manuel"] = "manuel"
    code_barres: str | None = Field(default=None, pattern=r"^\d{8,14}$")
    base: Literal["100g", "portion"] = "100g"
    quantite_g: float | None = Field(default=None, gt=0, le=3000)
    kcal: float = Field(ge=0, le=5000)
    proteines: float = Field(default=0, ge=0, le=1000)
    glucides: float = Field(default=0, ge=0, le=1000)
    lipides: float = Field(default=0, ge=0, le=1000)

    @model_validator(mode="after")
    def verifier_coherence(self):
        if self.base == "100g":
            if self.quantite_g is None:
                raise ValueError("quantite_g est obligatoire quand les valeurs sont données pour 100 g.")
            if self.kcal > 900 or any(getattr(self, m) > 100 for m in MACROS):
                raise ValueError("Valeurs impossibles pour 100 g (max 900 kcal et 100 g par macro).")
        if self.methode_ajout == "scan_barcode" and not self.code_barres:
            raise ValueError("code_barres est obligatoire pour un ajout par scan.")
        return self

    def en_ligne(self, repas_id: str) -> dict:
        facteur = self.quantite_g / 100 if self.base == "100g" else 1
        return {
            "repas_id": repas_id,
            "nom_aliment": self.nom_aliment.strip(),
            "methode_ajout": self.methode_ajout,
            "code_barres": self.code_barres,
            "quantite_g": self.quantite_g,
            "kcal": round(self.kcal * facteur),
            **{m: round(getattr(self, m) * facteur, 1) for m in MACROS},
            "est_estimation": False,
        }


@router.post("/journal/{jour}/{type_repas}/aliments", status_code=status.HTTP_201_CREATED)
def ajouter_aliment(
    jour: date,
    type_repas: TypeRepas,
    aliment: AlimentAjout,
    client: dict = Depends(client_courant),
    depot: DepotNutrition = Depends(get_depot),
):
    repas_id = depot.obtenir_ou_creer_repas(client["id"], jour, type_repas)
    return depot.ajouter_aliment(aliment.en_ligne(repas_id))


class AlimentModif(BaseModel):
    """Correction d'un aliment. Changer seulement quantite_g recalcule les valeurs au prorata."""

    nom_aliment: str | None = Field(default=None, min_length=1, max_length=200)
    quantite_g: float | None = Field(default=None, gt=0, le=3000)
    kcal: float | None = Field(default=None, ge=0, le=5000)
    proteines: float | None = Field(default=None, ge=0, le=1000)
    glucides: float | None = Field(default=None, ge=0, le=1000)
    lipides: float | None = Field(default=None, ge=0, le=1000)


@router.patch("/aliments/{aliment_id}")
def modifier_aliment(
    aliment_id: UUID,
    modif: AlimentModif,
    client: dict = Depends(client_courant),
    depot: DepotNutrition = Depends(get_depot),
):
    actuel = depot.aliment_du_client(str(aliment_id), client["id"])
    if not actuel:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Aliment introuvable.")

    champs = modif.model_dump(exclude_none=True)
    if not champs:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Aucune modification fournie.")

    valeurs_explicites = any(k in champs for k in ("kcal", *MACROS))
    ancienne_qte = actuel.get("quantite_g")
    if "quantite_g" in champs and not valeurs_explicites and ancienne_qte:
        ratio = champs["quantite_g"] / float(ancienne_qte)
        champs["kcal"] = round((actuel.get("kcal") or 0) * ratio)
        for m in MACROS:
            champs[m] = round(float(actuel.get(m) or 0) * ratio, 1)
    else:
        if "kcal" in champs:
            champs["kcal"] = round(champs["kcal"])
        for m in MACROS:
            if m in champs:
                champs[m] = round(champs[m], 1)
    if "nom_aliment" in champs:
        champs["nom_aliment"] = champs["nom_aliment"].strip()

    champs["est_estimation"] = False  # une valeur corrigée par le client n'est plus une estimation
    return depot.modifier_aliment(str(aliment_id), champs)


@router.delete("/aliments/{aliment_id}", status_code=status.HTTP_204_NO_CONTENT)
def supprimer_aliment(
    aliment_id: UUID,
    client: dict = Depends(client_courant),
    depot: DepotNutrition = Depends(get_depot),
):
    if not depot.aliment_du_client(str(aliment_id), client["id"]):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Aliment introuvable.")
    depot.supprimer_aliment(str(aliment_id))
    return Response(status_code=status.HTTP_204_NO_CONTENT)
