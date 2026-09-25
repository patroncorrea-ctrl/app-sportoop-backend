from datetime import date, datetime
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, File, HTTPException, Path, Query, Response, UploadFile, status
from pydantic import BaseModel, Field, model_validator

from app import gemini, limites, openfoodfacts
from app.auth import client_courant
from app.constantes import FUSEAU, TYPES_REPAS, Nom, TypeRepas
from app.depot import DepotNutrition, get_depot

router = APIRouter(tags=["nutrition"])

MACROS = ("proteines", "glucides", "lipides")

# Quantité mangée : 1 g minimum (la colonne NUMERIC(7,1) arrondirait 0,04 g à 0, refusé par son CHECK > 0)
QUANTITE_MIN_G = 0.1
QUANTITE_MAX_G = 3000
# Valeurs maximales d'un aliment enregistré : celles d'une saisie « pour 100 g » au maximum
# (3000 g à 900 kcal et 100 g de chaque macro pour 100 g). Les macros restent sous la capacité
# des colonnes NUMERIC(5,1) (9999,9) : un recalcul au prorata qui les dépasserait est refusé (422).
KCAL_MAX_ALIMENT = 900 * QUANTITE_MAX_G // 100
MACRO_MAX_ALIMENT = 100 * QUANTITE_MAX_G // 100


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
def quota_produits(client: dict = Depends(client_courant)) -> None:
    limites.DEBIT_PRODUITS.verifier(str(client["id"]))
    limites.DEBIT_PRODUITS_GLOBAL.verifier("serveur")  # quota Open Food Facts partagé par tous les clients


@router.get("/produits/{code_barres}")
def produit_par_code_barres(
    code_barres: str = Path(pattern=r"^\d{8,14}$"),
    _client: dict = Depends(client_courant),
    _quota: None = Depends(quota_produits),
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

    nom_aliment: Nom
    methode_ajout: Literal["scan_barcode", "manuel"] = "manuel"
    code_barres: str | None = Field(default=None, pattern=r"^\d{8,14}$")
    base: Literal["100g", "portion"] = "100g"
    quantite_g: float | None = Field(default=None, ge=QUANTITE_MIN_G, le=QUANTITE_MAX_G)
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
            "nom_aliment": self.nom_aliment,
            "methode_ajout": self.methode_ajout,
            "code_barres": self.code_barres,
            "quantite_g": round(self.quantite_g, 1) if self.quantite_g is not None else None,
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

    nom_aliment: Nom | None = None
    quantite_g: float | None = Field(default=None, ge=QUANTITE_MIN_G, le=QUANTITE_MAX_G)
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
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Aucune modification fournie.")

    if "quantite_g" in champs:
        champs["quantite_g"] = round(champs["quantite_g"], 1)
    valeurs_explicites = any(k in champs for k in ("kcal", *MACROS))
    ancienne_qte = actuel.get("quantite_g")
    if "quantite_g" in champs and not valeurs_explicites and ancienne_qte:
        ratio = champs["quantite_g"] / float(ancienne_qte)
        champs["kcal"] = round((actuel.get("kcal") or 0) * ratio)
        for m in MACROS:
            champs[m] = round(float(actuel.get(m) or 0) * ratio, 1)
        # Les valeurs recalculées ne passent pas par la validation du modèle : bornes contrôlées ici
        if champs["kcal"] > KCAL_MAX_ALIMENT or any(champs[m] > MACRO_MAX_ALIMENT for m in MACROS):
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT,
                "Quantité trop élevée pour les valeurs actuelles de cet aliment : "
                "corrigez aussi les kcal et les macros.",
            )
    else:
        if "kcal" in champs:
            champs["kcal"] = round(champs["kcal"])
        for m in MACROS:
            if m in champs:
                champs[m] = round(champs[m], 1)

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


# ---------------------------------------------------------------------------
# Photo d'assiette (estimation Gemini, corrigeable)
# ---------------------------------------------------------------------------
TYPES_IMAGE = {"image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"}
TAILLE_MAX_IMAGE = 8 * 1024 * 1024


def estimateur_disponible():
    try:
        return gemini.get_estimateur()
    except gemini.PhotoIADesactivee:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "L'estimation par photo n'est pas activée.")


def quota_photo(client: dict = Depends(client_courant)) -> None:
    limites.DEBIT_PHOTO.verifier(str(client["id"]))  # chaque estimation est facturée par Gemini


@router.post("/journal/{jour}/{type_repas}/photo", status_code=status.HTTP_201_CREATED)
def ajouter_par_photo(
    jour: date,
    type_repas: TypeRepas,
    photo: UploadFile = File(...),
    client: dict = Depends(client_courant),
    depot: DepotNutrition = Depends(get_depot),
    estimateur=Depends(estimateur_disponible),
    _quota: None = Depends(quota_photo),
):
    """Ajoute les aliments estimés par l'IA, marqués « est_estimation » : à vérifier et corriger par le client.

    La photo n'est ni stockée ni journalisée (donnée potentiellement sensible).
    """
    if photo.content_type not in TYPES_IMAGE:
        raise HTTPException(status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, "Format d'image non pris en charge.")
    image = photo.file.read(TAILLE_MAX_IMAGE + 1)
    if len(image) > TAILLE_MAX_IMAGE:
        raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, "Image trop lourde (8 Mo maximum).")
    if not image:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Image vide.")

    try:
        estimes = estimateur.estimer(image, photo.content_type)
    except gemini.EstimationImpossible as e:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(e))
    if not estimes:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Aucun aliment reconnu sur la photo.")

    repas_id = depot.obtenir_ou_creer_repas(client["id"], jour, type_repas)
    # Lignes déjà validées par le modèle AlimentEstime, puis insertion groupée : pas d'enregistrement partiel.
    # Quantité ramenée à 1 g minimum, comme pour une saisie manuelle.
    aliments = depot.ajouter_aliments([
        {
            "repas_id": repas_id,
            "nom_aliment": a["nom_aliment"],
            "methode_ajout": "photo_ia",
            "code_barres": None,
            "quantite_g": max(float(QUANTITE_MIN_G), round(a["quantite_g"], 1)),
            "kcal": round(a["kcal"]),
            **{m: round(a[m], 1) for m in MACROS},
            "est_estimation": True,
        }
        for a in estimes
    ])
    return {
        "avertissement": "Estimation automatique : vérifiez et corrigez les quantités et les valeurs.",
        "aliments": aliments,
    }