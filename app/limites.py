"""Protections des requêtes : taille des corps, présence du jeton et limitation de débit.

FastAPI lit (et met en tampon, en mémoire ou sur disque) le corps d'une requête AVANT de résoudre les
dépendances, donc avant l'authentification. Le middleware ProtectionRequetes refuse en amont, sans lire
le corps :
- 401 toute route non publique (routes client et coach) appelée sans en-tête « Authorization: Bearer … » ;
- 413 tout corps plus gros que la limite de la route : Content-Length annoncé, puis flux réellement reçu
  (un envoi « chunked » sans Content-Length est coupé dès que la limite est dépassée).
"""

import re
import threading
import time
from collections import deque

from starlette.exceptions import HTTPException
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

KO = 1024
LIMITE_PAR_DEFAUT = 64 * KO  # corps JSON des routes client / coach et des webhooks
LIMITE_PHOTO = 9 * KO * KO  # photo d'assiette (8 Mo maximum) + enveloppe multipart
ROUTE_PHOTO = re.compile(r"^/journal/[^/]+/[^/]+/photo/?$")

# Routes accessibles sans jeton (les webhooks ont leur propre secret ou signature).
# Toute autre route exige un jeton : une nouvelle route est donc protégée par défaut.
CHEMINS_PUBLICS = {"/", "/app", "/docs", "/docs/oauth2-redirect", "/redoc", "/openapi.json"}
PREFIXES_PUBLICS = ("/app/", "/webhooks/")


def limite_pour(chemin: str) -> int:
    return LIMITE_PHOTO if ROUTE_PHOTO.match(chemin) else LIMITE_PAR_DEFAUT


def route_publique(chemin: str) -> bool:
    return chemin in CHEMINS_PUBLICS or chemin.startswith(PREFIXES_PUBLICS)


def jeton_present(en_tetes: list[tuple[bytes, bytes]]) -> bool:
    for nom, valeur in en_tetes:
        if nom.lower() == b"authorization":
            texte = valeur.decode("latin-1").strip()
            return texte[:7].lower() == "bearer " and bool(texte[7:].strip())
    return False


class CorpsTropVolumineux(HTTPException):
    def __init__(self) -> None:
        super().__init__(413, "Requête trop volumineuse.")


def _reponse(code: int, message: str, en_tetes: dict | None = None) -> JSONResponse:
    return JSONResponse({"detail": message}, status_code=code, headers=en_tetes)


class ProtectionRequetes:
    """Middleware ASGI : refus 401 / 413 avant toute lecture du corps."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        chemin = scope["path"]
        if not route_publique(chemin) and not jeton_present(scope["headers"]):
            reponse = _reponse(401, "Jeton d'authentification manquant.", {"WWW-Authenticate": "Bearer"})
            await reponse(scope, receive, send)
            return

        limite = limite_pour(chemin)
        annonce = next((v for n, v in scope["headers"] if n.lower() == b"content-length"), None)
        if annonce is not None:
            try:
                taille = int(annonce)
            except ValueError:
                await _reponse(400, "En-tête Content-Length invalide.")(scope, receive, send)
                return
            if taille > limite:
                await _reponse(413, "Requête trop volumineuse.")(scope, receive, send)
                return

        recu = 0
        reponse_commencee = False

        async def recevoir_borne() -> Message:
            nonlocal recu
            message = await receive()
            if message["type"] == "http.request":
                recu += len(message.get("body", b""))
                if recu > limite:
                    # Levée pendant la lecture : FastAPI la relaie telle quelle (réponse 413)
                    raise CorpsTropVolumineux()
            return message

        async def envoyer_suivi(message: Message) -> None:
            nonlocal reponse_commencee
            if message["type"] == "http.response.start":
                reponse_commencee = True
            await send(message)

        try:
            await self.app(scope, recevoir_borne, envoyer_suivi)
        except CorpsTropVolumineux:
            if reponse_commencee:
                raise
            await _reponse(413, "Requête trop volumineuse.")(scope, receive, send)


# ---------------------------------------------------------------------------
# Limitation de débit
# ---------------------------------------------------------------------------
class LimiteurDebit:
    """Limitation de débit en mémoire par clé (id client), sur une ou plusieurs fenêtres glissantes.

    fenetres : liste de (nombre maximal d'appels, durée en secondes). La mémoire est propre au processus :
    suffisant avec l'unique worker uvicorn de Railway (compteurs remis à zéro à chaque redémarrage).
    """

    NB_CLES_AVANT_PURGE = 10_000

    def __init__(self, fenetres: list[tuple[int, int]], message: str) -> None:
        self.fenetres = fenetres
        self.message = message
        self.duree_max = max(duree for _, duree in fenetres)
        self._appels: dict[str, deque[float]] = {}
        self._verrou = threading.Lock()

    def verifier(self, cle: str) -> None:
        """Enregistre l'appel, ou lève une 429 (avec Retry-After) si une fenêtre est pleine."""
        maintenant = time.monotonic()
        with self._verrou:
            if len(self._appels) > self.NB_CLES_AVANT_PURGE:
                self._purger(maintenant)
            appels = self._appels.setdefault(cle, deque())
            while appels and appels[0] <= maintenant - self.duree_max:
                appels.popleft()
            for maximum, duree in self.fenetres:
                dans_fenetre = [t for t in appels if t > maintenant - duree]
                if len(dans_fenetre) >= maximum:
                    attente = int(dans_fenetre[0] + duree - maintenant) + 1
                    raise HTTPException(429, self.message, headers={"Retry-After": str(attente)})
            appels.append(maintenant)

    def _purger(self, maintenant: float) -> None:
        for cle in [c for c, a in self._appels.items() if not a or a[-1] <= maintenant - self.duree_max]:
            del self._appels[cle]

    def reinitialiser(self) -> None:
        with self._verrou:
            self._appels.clear()


# Photo d'assiette : chaque appel est facturé par Gemini
DEBIT_PHOTO = LimiteurDebit(
    [(6, 60), (40, 24 * 3600)],
    "Trop de photos envoyées : réessayez un peu plus tard.",
)
# Open Food Facts : quota d'environ 100 requêtes produit par minute pour l'IP (unique) du serveur
DEBIT_PRODUITS = LimiteurDebit([(30, 60)], "Trop de recherches de produits : réessayez dans une minute.")
DEBIT_PRODUITS_GLOBAL = LimiteurDebit(
    [(90, 60)], "Recherche de produits momentanément saturée : réessayez dans une minute.")
