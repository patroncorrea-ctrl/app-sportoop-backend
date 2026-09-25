"""Estimation des aliments d'une photo d'assiette avec Google Gemini.

RGPD : la photo est transmise à Google uniquement pour l'estimation, n'est ni stockée ni journalisée par l'API.
Le service est désactivé tant que PHOTO_IA_ACTIVE n'est pas « true » (à activer après mise à jour de la
politique de confidentialité, et uniquement avec une clé Gemini du niveau payant : sur le niveau gratuit,
Google peut réutiliser les contenus envoyés).
"""

import os

from pydantic import BaseModel, Field, ValidationError

MODELE_PAR_DEFAUT = "gemini-3.8-flash"

CONSIGNE = (
    "Tu es un assistant de nutrition. Identifie chaque aliment visible sur la photo du repas. "
    "Pour chacun, estime la quantité en grammes et les valeurs nutritionnelles TOTALES pour cette quantité "
    "(kcal, protéines, glucides, lipides en grammes). Donne des noms d'aliments courts, en français. "
    "Si la photo ne montre pas de nourriture, renvoie une liste vide."
)


class AlimentEstime(BaseModel):
    nom_aliment: str = Field(min_length=1, max_length=200)
    quantite_g: float = Field(gt=0, le=3000)
    kcal: float = Field(ge=0, le=5000)
    proteines: float = Field(ge=0, le=1000)
    glucides: float = Field(ge=0, le=1000)
    lipides: float = Field(ge=0, le=1000)


class Estimation(BaseModel):
    aliments: list[AlimentEstime]


class EstimationImpossible(Exception):
    pass


class PhotoIADesactivee(Exception):
    pass


class EstimateurGemini:
    def __init__(self, api_key: str, modele: str):
        from google import genai  # import local : inutile de charger le SDK si le service est désactivé

        self._types = genai.types
        self.client = genai.Client(api_key=api_key)
        self.modele = modele

    def estimer(self, image: bytes, mime_type: str) -> list[dict]:
        types = self._types
        try:
            reponse = self.client.models.generate_content(
                model=self.modele,
                contents=[types.Part.from_bytes(data=image, mime_type=mime_type), CONSIGNE],
                config=types.GenerateContentConfig(
                    response_mime_type="application/json",
                    response_schema=Estimation,
                    temperature=0.2,
                ),
            )
            estimation = Estimation.model_validate_json(reponse.text or "")
        except ValidationError as e:
            raise EstimationImpossible("Réponse de l'IA inexploitable.") from e
        except Exception as e:  # erreurs réseau / quota / API : pas de détail (pas de fuite de contenu)
            raise EstimationImpossible("Service d'estimation indisponible.") from e
        return [a.model_dump() for a in estimation.aliments]


def get_estimateur() -> EstimateurGemini:
    if os.getenv("PHOTO_IA_ACTIVE", "").lower() != "true":
        raise PhotoIADesactivee()
    cle = os.getenv("GEMINI_API_KEY")
    if not cle:
        raise PhotoIADesactivee()
    return EstimateurGemini(cle, os.getenv("GEMINI_MODEL", MODELE_PAR_DEFAUT))
