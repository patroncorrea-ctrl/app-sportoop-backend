"""Accès aux données nutrition dans Supabase (clé service_role : les contrôles d'accès sont faits ici)."""

from datetime import date

from fastapi import Depends
from supabase import Client

from app.db import get_supabase

CHAMPS_ALIMENT = (
    "id,repas_id,nom_aliment,quantite_g,kcal,proteines,glucides,lipides,"
    "methode_ajout,code_barres,est_estimation,created_at"
)


class DepotNutrition:
    def __init__(self, supabase: Client):
        self.db = supabase

    def client_par_user_id(self, user_id: str) -> dict | None:
        lignes = (
            self.db.table("clients")
            .select("id,nom,target_kcal,target_proteines,target_glucides,target_lipides,statut_abonnement")
            .eq("user_id", user_id)
            .limit(1)
            .execute()
            .data
        )
        return lignes[0] if lignes else None

    def repas_du_jour(self, client_id: str, jour: date) -> list[dict]:
        """Blocs repas existants du jour, chacun avec sa liste « aliments »."""
        lignes = (
            self.db.table("journal_repas")
            .select(f"id,type_repas,target_kcal,consigne_coach,aliments_scannes({CHAMPS_ALIMENT})")
            .eq("client_id", client_id)
            .eq("date_repas", jour.isoformat())
            .execute()
            .data
        )
        return [{**l, "aliments": l.pop("aliments_scannes", None) or []} for l in lignes]

    def obtenir_ou_creer_repas(self, client_id: str, jour: date, type_repas: str) -> str:
        # Unicité (client_id, date_repas, type_repas) garantie en base : l'upsert renvoie le bloc existant.
        ligne = (
            self.db.table("journal_repas")
            .upsert(
                {"client_id": client_id, "date_repas": jour.isoformat(), "type_repas": type_repas},
                on_conflict="client_id,date_repas,type_repas",
            )
            .execute()
            .data[0]
        )
        return ligne["id"]

    def ajouter_aliment(self, donnees: dict) -> dict:
        return self.db.table("aliments_scannes").insert(donnees).execute().data[0]

    def ajouter_aliments(self, lignes: list[dict]) -> list[dict]:
        """Insertion groupée : un seul appel PostgREST, donc tout ou rien."""
        return self.db.table("aliments_scannes").insert(lignes).execute().data

    def aliment_du_client(self, aliment_id: str, client_id: str) -> dict | None:
        """L'aliment seulement s'il appartient à un repas de ce client."""
        lignes = (
            self.db.table("aliments_scannes")
            .select(f"{CHAMPS_ALIMENT},journal_repas!inner(client_id)")
            .eq("id", aliment_id)
            .eq("journal_repas.client_id", client_id)
            .execute()
            .data
        )
        if not lignes:
            return None
        lignes[0].pop("journal_repas", None)
        return lignes[0]

    def modifier_aliment(self, aliment_id: str, champs: dict) -> dict:
        return self.db.table("aliments_scannes").update(champs).eq("id", aliment_id).execute().data[0]

    def supprimer_aliment(self, aliment_id: str) -> None:
        self.db.table("aliments_scannes").delete().eq("id", aliment_id).execute()


def get_depot(supabase: Client = Depends(get_supabase)) -> DepotNutrition:
    return DepotNutrition(supabase)
