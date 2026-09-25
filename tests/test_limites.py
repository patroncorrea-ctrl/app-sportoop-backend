import asyncio

import pytest
from fastapi.testclient import TestClient

from app.limites import LIMITE_PAR_DEFAUT, LimiteurDebit, jeton_present, limite_pour, route_publique
from app.main import app


def appel_asgi(methode, chemin, en_tetes=(), morceaux=(b"",)):
    """Appelle l'application ASGI directement et compte les lectures du corps (receive)."""
    lectures = []
    messages = []
    restants = list(morceaux)

    async def receive():
        lectures.append(1)
        corps = restants.pop(0) if restants else b""
        return {"type": "http.request", "body": corps, "more_body": bool(restants)}

    async def send(message):
        messages.append(message)

    scope = {
        "type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": methode,
        "scheme": "http", "path": chemin, "raw_path": chemin.encode(), "query_string": b"", "root_path": "",
        "headers": [(n.lower().encode(), v.encode()) for n, v in en_tetes],
        "client": ("127.0.0.1", 1234), "server": ("testserver", 80),
    }
    asyncio.run(app(scope, receive, send))
    statut = next(m["status"] for m in messages if m["type"] == "http.response.start")
    return statut, len(lectures)


# --- Jeton exigé avant toute lecture ----------------------------------------

@pytest.mark.parametrize("chemin", [
    "/journal/2026-09-25/DINER/photo", "/journal/2026-09-25/DINER/aliments", "/coach/clients/x/invitation",
])
def test_sans_jeton_401_sans_lire_le_corps(chemin):
    en_tetes = [("content-type", "multipart/form-data; boundary=x"), ("content-length", "50000000")]
    assert appel_asgi("POST", chemin, en_tetes, [b"x" * 1000] * 5) == (401, 0)


def test_json_invalide_sans_jeton_donne_401_et_non_422():
    r = TestClient(app).post("/journal/2026-09-25/DINER/aliments", content=b"{pas du json",
                             headers={"Content-Type": "application/json"})
    assert r.status_code == 401 and r.headers["WWW-Authenticate"] == "Bearer"


@pytest.mark.parametrize("valeur", [None, "Basic abc", "Bearer ", "Bearer    "])
def test_en_tete_authorization_invalide(valeur):
    en_tetes = {"Authorization": valeur} if valeur else {}
    assert TestClient(app).get("/journal", headers=en_tetes).status_code == 401


def test_routes_publiques_sans_jeton(monkeypatch):
    monkeypatch.delenv("SYSTEMEIO_WEBHOOK_SECRET", raising=False)
    api = TestClient(app)
    assert api.get("/").status_code == 200
    assert api.get("/app/").status_code == 200
    assert api.get("/openapi.json").status_code == 200
    # Les webhooks ont leur propre protection (ici : secret non configuré)
    assert api.post("/webhooks/systemeio", content=b"{}").status_code == 503


def test_route_inconnue_protegee_par_defaut():
    assert TestClient(app).get("/nouvelle-route").status_code == 401


def test_classement_des_routes():
    assert route_publique("/webhooks/nouveau-client") and route_publique("/app/coach/")
    assert not route_publique("/journal") and not route_publique("/coach/clients/x")
    assert not route_publique("/application")  # préfixe « /app » seul ne suffit pas
    assert limite_pour("/journal/2026-09-25/DINER/photo") > limite_pour("/journal/2026-09-25/DINER/aliments")
    assert jeton_present([(b"Authorization", b"bearer abc")])


# --- Taille des corps -------------------------------------------------------

def test_content_length_trop_grand_413_sans_lire():
    en_tetes = [("authorization", "Bearer x"), ("content-type", "application/json"),
                ("content-length", str(LIMITE_PAR_DEFAUT + 1))]
    assert appel_asgi("POST", "/journal/2026-09-25/DINER/aliments", en_tetes, [b"{}"]) == (413, 0)


def test_webhook_trop_grand_413_sans_lire():
    en_tetes = [("content-type", "application/json"), ("content-length", "30000000")]
    assert appel_asgi("POST", "/webhooks/nouveau-client", en_tetes, [b"{}"]) == (413, 0)


def test_flux_sans_content_length_coupe_a_la_limite():
    # Envoi « chunked » : lecture interrompue dès que la limite est dépassée
    en_tetes = [("authorization", "Bearer x"), ("content-type", "application/json")]
    morceaux = [b" " * 16 * 1024] * 100  # 1,6 Mo annoncés morceau par morceau
    statut, lectures = appel_asgi("POST", "/journal/2026-09-25/DINER/aliments", en_tetes, morceaux)
    assert statut == 413 and lectures <= 5


def test_flux_webhook_systemeio_coupe_a_la_limite(monkeypatch):
    monkeypatch.setenv("SYSTEMEIO_WEBHOOK_SECRET", "s")
    en_tetes = [("content-type", "application/json"), ("x-webhook-signature", "0" * 64)]
    statut, lectures = appel_asgi("POST", "/webhooks/systemeio", en_tetes, [b" " * 16 * 1024] * 100)
    assert statut == 413 and lectures <= 5


def test_content_length_invalide():
    en_tetes = [("authorization", "Bearer x"), ("content-length", "abc")]
    assert appel_asgi("POST", "/journal/2026-09-25/DINER/aliments", en_tetes)[0] == 400


# --- Limiteur de débit ------------------------------------------------------

def test_limiteur_fenetres_et_cles(monkeypatch):
    horloge = [1000.0]
    monkeypatch.setattr("app.limites.time.monotonic", lambda: horloge[0])
    limiteur = LimiteurDebit([(2, 60), (3, 3600)], "Trop d'appels.")
    limiteur.verifier("a")
    limiteur.verifier("a")
    limiteur.verifier("b")  # autre client : compteur séparé
    with pytest.raises(Exception) as refus:
        limiteur.verifier("a")
    assert refus.value.status_code == 429 and refus.value.headers["Retry-After"] == "61"
    horloge[0] += 61  # fenêtre d'une minute écoulée
    limiteur.verifier("a")
    with pytest.raises(Exception):
        limiteur.verifier("a")  # plafond horaire (3) atteint
    horloge[0] += 3600
    limiteur.verifier("a")
