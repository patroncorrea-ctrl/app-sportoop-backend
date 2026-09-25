from typing import Annotated, Literal
from zoneinfo import ZoneInfo

from pydantic import StringConstraints

# Nom (client, aliment) : espaces retirés AVANT le contrôle de longueur, donc « "   " » est refusé (422)
Nom = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]

# Statuts d'abonnement (clients.statut_abonnement) : seul ACTIF donne accès à l'application
STATUT_ACTIF = "ACTIF"
STATUT_EN_ATTENTE = "EN_ATTENTE"  # fiche créée par le formulaire, avant tout achat
STATUT_RESILIE = "RESILIE"

# Les 8 blocs repas, dans l'ordre chronologique d'affichage (valeurs exactes de journal_repas.type_repas)
TYPES_REPAS = (
    "PETIT_DEJEUNER",
    "COLLATION_MATIN",
    "DEJEUNER",
    "COLLATION_APRES_MIDI",
    "DINER",
    "PRE_WORKOUT",
    "WORKOUT",
    "POST_WORKOUT",
)
TypeRepas = Literal[
    "PETIT_DEJEUNER",
    "COLLATION_MATIN",
    "DEJEUNER",
    "COLLATION_APRES_MIDI",
    "DINER",
    "PRE_WORKOUT",
    "WORKOUT",
    "POST_WORKOUT",
]

# Valeurs exactes de seances.jour_semaine, index = date.weekday()
JOURS_SEMAINE = ("Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi", "Dimanche")

# Fuseau de référence pour « aujourd'hui »
FUSEAU = ZoneInfo("Europe/Paris")
