import hashlib
import hmac
import json

import pytest
from fastapi.testclient import TestClient

from app.auth import utilisateur_courant
from app.db import get_supabase
from app.depot import get_depot
from app.main import app
from app.systemeio import normaliser, signature_valide

SECRET = "secret-systeme"


class FausseTable:
    """Table « clients » en mémoire : select/eq/limit, insert, update/eq."""

    def __init__(self, lignes):
        self.lignes = lignes

    def select(self, _champs):
        self._op, self._filtres = "select", []
        return self

    def insert(self, donnees):
        self._op, self._donnees = "insert", donnees
        return self

    def update(self, donnees):
        self._op, self._donnees, self._filtres = "update", donnees, []
        return self

    def eq(self, champ, valeur):
        self._filtres.append((champ, valeur))
        return self

    def limit(self, _n):
        return self

    def _correspond(self, ligne):
        return all(ligne.get(c) == v for c, v in self._filtres)

    def execute(self):
        if self._op == "insert":
            ligne = {"id": f"id{len(self.lignes)}", **self._donnees}
            self.lignes.append(ligne)
            return type("R", (), {"data": [ligne]})()
        cibles = [l for l in self.lignes if self._correspond(l)]
        if self._op == "update":
            for l in cibles:
                l.update(self._donnees)
        return type("R", (), {"data": cibles})()


@pytest.fixture
def clients(monkeypatch):
    lignes = []
    db = type("DB", (), {"table": lambda self, nom: FausseTable(lignes)})()
    app.dependency_overrides[get_supabase] = lambda: db
    monkeypatch.setenv("SYSTEMEIO_WEBHOOK_SECRET", SECRET)
    yield lignes
    app.dependency_overrides.clear()


def vente(email="Marie@Exemple.fr", prenom="Marie", nom="Dupré"):
    return {"customer": {"contactId": 987, "email": email,
                         "fields": {"first_name": prenom, "surname": nom}},
            "pricePlan": {"name": "Coaching / mois"}}


def envoyer(evenement, donnees, signer=True, secret=SECRET, brut=None):
    corps = brut if brut is not None else json.dumps(donnees, ensure_ascii=False, indent=2).encode()
    en_tetes = {"X-Webhook-Event": evenement, "Content-Type": "application/json"}
    if signer:
        en_tetes["X-Webhook-Signature"] = hmac.new(secret.encode(), normaliser(corps), hashlib.sha256).hexdigest()
    return TestClient(app).post("/webhooks/systemeio", content=corps, headers=en_tetes)


# --- Signature --------------------------------------------------------------

def test_normalisation_style_php():
    assert normaliser('{"a": "Prénom", "u": "http://x.fr"}'.encode()) == \
        b'{"a":"Pr\\u00e9nom","u":"http:\\/\\/x.fr"}'


def test_signature_sur_corps_brut_acceptee():
    corps = b'{"a":1}'
    sig = hmac.new(b"s", corps, hashlib.sha256).hexdigest()
    assert signature_valide(corps, sig, "s")
    assert not signature_valide(corps, sig, "autre")
    assert not signature_valide(corps, None, "s")


def test_sans_signature_refuse(clients):
    assert envoyer("SALE_NEW", vente(), signer=False).status_code == 401
    assert clients == []


def test_mauvaise_signature_refusee(clients):
    assert envoyer("SALE_NEW", vente(), secret="pirate").status_code == 401


def test_secret_absent_refuse(clients, monkeypatch):
    monkeypatch.delenv("SYSTEMEIO_WEBHOOK_SECRET")
    assert envoyer("SALE_NEW", vente()).status_code == 503


# --- Événements -------------------------------------------------------------

def test_nouvelle_vente_cree_le_client(clients):
    r = envoyer("SALE_NEW", vente())
    assert r.json()["action"] == "abonnement_actif"
    c = clients[0]
    assert (c["email"], c["nom"], c["statut_abonnement"], c["systemeio_contact_id"]) == (
        "marie@exemple.fr", "Marie Dupré", "ACTIF", 987)


def test_nouvelle_vente_client_existant_garde_son_nom(clients):
    clients.append({"id": "x", "email": "marie@exemple.fr", "nom": "Marie (formulaire)",
                    "statut_abonnement": "RESILIE"})
    envoyer("SALE_NEW", vente())
    assert len(clients) == 1
    assert (clients[0]["nom"], clients[0]["statut_abonnement"]) == ("Marie (formulaire)", "ACTIF")


def test_nom_par_defaut_sans_prenom(clients):
    envoyer("SALE_NEW", vente(prenom=None, nom=None))
    assert clients[0]["nom"] == "marie"


def test_resiliation(clients):
    envoyer("SALE_NEW", vente())
    r = envoyer("SALE_CANCELED", vente())
    assert r.json()["action"] == "abonnement_resilie"
    assert clients[0]["statut_abonnement"] == "RESILIE"


def test_resiliation_client_inconnu_ignoree(clients):
    assert envoyer("SALE_CANCELED", vente()).json()["status"] == "ignore"
    assert clients == []


def test_autre_evenement_ignore(clients):
    assert envoyer("CONTACT_CREATED", vente()).json()["status"] == "ignore"
    assert clients == []


def test_email_absent(clients):
    assert envoyer("SALE_NEW", {"customer": {}}).status_code == 422


# --- Accès bloqué après résiliation -----------------------------------------

def test_client_resilie_bloque():
    depot = type("D", (), {"client_par_user_id": lambda self, uid: {"id": "c1", "statut_abonnement": "RESILIE"}})()
    app.dependency_overrides[get_depot] = lambda: depot
    app.dependency_overrides[utilisateur_courant] = lambda: "u1"
    try:
        r = TestClient(app).get("/journal")
        assert r.status_code == 403 and "résilié" in r.json()["detail"]
    finally:
        app.dependency_overrides.clear()
