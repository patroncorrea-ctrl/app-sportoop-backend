"""Accès aux données sport dans Supabase (clé service_role : les contrôles d'accès sont faits ici)."""

from datetime import date

from fastapi import Depends
from supabase import Client

from app.db import get_supabase


class DepotSport:
    def __init__(self, supabase: Client):
        self.db = supabase

    def seances_du_client(self, client_id: str) -> list[dict]:
        return (
            self.db.table("seances")
            .select("id,titre,jour_semaine,duree,video_url,ordre")
            .eq("client_id", client_id)
            .order("ordre")
            .execute()
            .data
        )

    def seance_du_client(self, seance_id: str, client_id: str) -> dict | None:
        lignes = (
            self.db.table("seances")
            .select("id,titre,jour_semaine,duree,video_url,ordre")
            .eq("id", seance_id)
            .eq("client_id", client_id)
            .execute()
            .data
        )
        return lignes[0] if lignes else None

    def realisations_entre(self, client_id: str, debut: date, fin: date) -> list[dict]:
        return (
            self.db.table("seances_realisees")
            .select("seance_id,date_realisee,statut,ressenti,commentaire")
            .eq("client_id", client_id)
            .gte("date_realisee", debut.isoformat())
            .lte("date_realisee", fin.isoformat())
            .execute()
            .data
        )

    def enregistrer_realisation(self, donnees: dict) -> dict:
        # Unicité (seance_id, date_realisee) en base : revalider le même jour met à jour la ligne.
        return (
            self.db.table("seances_realisees")
            .upsert(donnees, on_conflict="seance_id,date_realisee")
            .execute()
            .data[0]
        )

    def regles_actives(self, client_id: str, declencheur: str) -> list[dict]:
        return (
            self.db.table("regles_redirection")
            .select("id,client_id,seance_id,cible_type,cible,priorite")
            .eq("declencheur", declencheur)
            .eq("actif", True)
            .or_(f"client_id.is.null,client_id.eq.{client_id}")
            .execute()
            .data
        )

    def boutons_actifs(self, client_id: str, emplacement: str | None) -> list[dict]:
        requete = (
            self.db.table("boutons_actions")
            .select("id,emplacement,libelle,action_type,cible,ordre")
            .eq("actif", True)
            .or_(f"client_id.is.null,client_id.eq.{client_id}")
        )
        if emplacement:
            requete = requete.eq("emplacement", emplacement)
        return requete.order("ordre").execute().data


def get_depot_sport(supabase: Client = Depends(get_supabase)) -> DepotSport:
    return DepotSport(supabase)
