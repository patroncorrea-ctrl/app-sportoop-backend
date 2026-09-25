from datetime import date, timedelta
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field

from app.auth import client_courant
from app.constantes import JOURS_SEMAINE
from app.depot_sport import DepotSport, get_depot_sport
from app.routes_nutrition import aujourdhui

router = APIRouter(tags=["sport"])

DECLENCHEURS = {"FAIT": "SEANCE_VALIDEE", "MANQUE": "SEANCE_MANQUEE"}


def choisir_redirection(regles: list[dict], client_id: str, seance_id: str) -> dict | None:
    """Règle la plus spécifique : client + séance > client > séance > globale, puis priorité croissante."""
    applicables = [
        r for r in regles
        if r.get("client_id") in (None, client_id) and r.get("seance_id") in (None, seance_id)
    ]
    if not applicables:
        return None
    meilleure = min(
        applicables,
        key=lambda r: (-(2 * (r.get("client_id") is not None) + (r.get("seance_id") is not None)),
                       r.get("priorite") or 0),
    )
    return {"cible_type": meilleure["cible_type"], "cible": meilleure["cible"]}


@router.get("/seances/semaine")
def programme_de_la_semaine(
    jour: date | None = Query(default=None, alias="date"),
    client: dict = Depends(client_courant),
    depot: DepotSport = Depends(get_depot_sport),
):
    """Programme de la semaine (lundi → dimanche) contenant la date, avec l'état de chaque séance."""
    jour = jour or aujourdhui()
    lundi = jour - timedelta(days=jour.weekday())
    dimanche = lundi + timedelta(days=6)

    seances = depot.seances_du_client(client["id"])
    realisations = {
        (r["seance_id"], r["date_realisee"]): r
        for r in depot.realisations_entre(client["id"], lundi, dimanche)
    }

    jours = []
    for i, nom_jour in enumerate(JOURS_SEMAINE):
        d = lundi + timedelta(days=i)
        jours.append({
            "jour_semaine": nom_jour,
            "date": d.isoformat(),
            "seances": [
                {**s, "realisation": realisations.get((s["id"], d.isoformat()))}
                for s in sorted(seances, key=lambda s: s.get("ordre") or 0)
                if s["jour_semaine"] == nom_jour
            ],
        })
    return {"du": lundi.isoformat(), "au": dimanche.isoformat(), "jours": jours}


class Validation(BaseModel):
    jour: date | None = Field(default=None, alias="date")
    statut: Literal["FAIT", "MANQUE"] = "FAIT"
    ressenti: int | None = Field(default=None, ge=1, le=5)
    commentaire: str | None = Field(default=None, max_length=1000)


@router.post("/seances/{seance_id}/validation")
def valider_seance(
    seance_id: UUID,
    validation: Validation,
    client: dict = Depends(client_courant),
    depot: DepotSport = Depends(get_depot_sport),
):
    """Enregistre la séance comme faite / manquée et renvoie la redirection prévue par le coach."""
    seance = depot.seance_du_client(str(seance_id), client["id"])
    if not seance:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Séance introuvable.")
    jour = validation.jour or aujourdhui()
    if jour > aujourdhui():
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Impossible de valider une séance future.")

    realisation = depot.enregistrer_realisation({
        "client_id": client["id"],
        "seance_id": seance["id"],
        "titre": seance["titre"],
        "date_realisee": jour.isoformat(),
        "statut": validation.statut,
        "ressenti": validation.ressenti,
        "commentaire": validation.commentaire.strip() if validation.commentaire else None,
    })
    regles = depot.regles_actives(client["id"], DECLENCHEURS[validation.statut])
    return {"realisation": realisation, "redirection": choisir_redirection(regles, client["id"], seance["id"])}


@router.get("/boutons")
def boutons(
    emplacement: str | None = Query(default=None, max_length=50),
    client: dict = Depends(client_courant),
    depot: DepotSport = Depends(get_depot_sport),
):
    """Boutons d'action dynamiques configurés par le coach (globaux + propres au client)."""
    return depot.boutons_actifs(client["id"], emplacement)
