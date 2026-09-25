from typing import Literal
from zoneinfo import ZoneInfo

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
