import hashlib
import hmac
import json

import pytest
from fastapi.testclient import TestClient

from app.auth import utilisateur_courant
from app.db import get_supabase
from app.depot import get_depot
from app.main import app
from tests.conftest import JETON
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


def vente(email="Marie@Exemple.fr", prenom="Marie", nom="Dupré", plan=94283):
    return {"customer": {"contactId": 987, "email": email,
                         "fields": {"first_name": prenom, "surname": nom}},
            "pricePlan": {"id": plan, "name": "Coaching / mois"}}


def envoyer(evenement, donnees, signer=True, secret=SECRET, brut=None, horodatage=None, signature=None):
    corps = brut if brut is not None else json.dumps(donnees, ensure_ascii=False, indent=2).encode()
    en_tetes = {"X-Webhook-Event": evenement, "Content-Type": "application/json"}
    if signature:
        en_tetes["X-Webhook-Signature"] = signature
    elif signer:
        en_tetes["X-Webhook-Signature"] = hmac.new(secret.encode(), normaliser(corps), hashlib.sha256).hexdigest()
    if horodatage:
        en_tetes["X-Webhook-Event-Timestamp"] = horodatage
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


def test_vente_active_une_fiche_en_attente(clients):
    clients.append({"id": "x", "email": "marie@exemple.fr", "nom": "Marie", "statut_abonnement": "EN_ATTENTE",
                    "abonnement_maj_le": None})
    assert envoyer("SALE_NEW", vente()).json()["action"] == "abonnement_actif"
    assert clients[0]["statut_abonnement"] == "ACTIF"


# --- Ordre des événements et rejeu ------------------------------------------

T1, T2 = "2026-09-01T10:00:00+00:00", "2026-09-20T08:30:00+00:00"


def test_horodatage_de_l_evenement_enregistre(clients):
    envoyer("SALE_NEW", vente(), horodatage=T1)
    assert clients[0]["abonnement_maj_le"] == T1


def test_evenement_plus_ancien_ignore(clients):
    envoyer("SALE_NEW", vente(), horodatage=T1)
    envoyer("SALE_CANCELED", vente(), horodatage=T2)
    # Nouvelle livraison tardive (ou rejeu) de la vente : même horodatage d'événement T1
    r = envoyer("SALE_NEW", vente(), horodatage=T1)
    assert r.json()["status"] == "ignore"
    assert (clients[0]["statut_abonnement"], clients[0]["abonnement_maj_le"]) == ("RESILIE", T2)


def test_nouvel_achat_apres_resiliation(clients):
    envoyer("SALE_NEW", vente(), horodatage=T1)
    envoyer("SALE_CANCELED", vente(), horodatage=T2)
    envoyer("SALE_NEW", vente(), horodatage="2026-09-24T09:00:00Z")
    assert clients[0]["statut_abonnement"] == "ACTIF"


def test_resiliation_ancienne_ignoree(clients):
    envoyer("SALE_NEW", vente(), horodatage=T2)
    assert envoyer("SALE_CANCELED", vente(), horodatage=T1).json()["status"] == "ignore"
    assert clients[0]["statut_abonnement"] == "ACTIF"


# --- Offres suivies ---------------------------------------------------------

def test_offre_non_suivie_ignoree(clients, monkeypatch):
    monkeypatch.setenv("SYSTEMEIO_PRICE_PLAN_IDS", "111, 94283")
    r = envoyer("SALE_NEW", vente(plan=555))  # ex. un ebook vendu sur le même compte
    assert r.json() == {"status": "ignore", "raison": "offre non suivie"} and clients == []
    envoyer("SALE_NEW", vente(plan=94283))
    assert clients[0]["statut_abonnement"] == "ACTIF"


def test_remboursement_d_une_autre_offre_ne_resilie_pas(clients, monkeypatch):
    monkeypatch.setenv("SYSTEMEIO_PRICE_PLAN_IDS", "94283")
    envoyer("SALE_NEW", vente())
    assert envoyer("SALE_CANCELED", vente(plan=555)).json()["status"] == "ignore"
    assert clients[0]["statut_abonnement"] == "ACTIF"


# --- Corps hostiles ---------------------------------------------------------

def test_json_tres_imbrique_non_signe(clients):
    corps = b"[" * 30000 + b"]" * 30000  # < 64 Ko, mais au-delà de la profondeur de récursion
    assert envoyer("SALE_NEW", None, brut=corps, signature="0" * 64).status_code == 401


def test_json_tres_imbrique_signe(clients):
    corps = b"[" * 30000 + b"]" * 30000
    signature = hmac.new(SECRET.encode(), corps, hashlib.sha256).hexdigest()  # signature du corps brut
    assert envoyer("SALE_NEW", None, brut=corps, signature=signature).status_code == 422
    assert clients == []


def test_corps_trop_volumineux(clients):
    corps = json.dumps({"customer": {"email": "a@b.fr"}, "x": "a" * 70_000}).encode()
    assert envoyer("SALE_NEW", None, brut=corps).status_code == 413
    assert clients == []


# --- Accès bloqué après résiliation -----------------------------------------

@pytest.mark.parametrize("statut, extrait", [
    ("RESILIE", "résilié"), ("EN_ATTENTE", "attente"), (None, "inactif"), ("INCONNU", "inactif")])
def test_seul_un_abonnement_actif_donne_acces(statut, extrait):
    depot = type("D", (), {"client_par_user_id": lambda self, uid: {"id": "c1", "statut_abonnement": statut}})()
    app.dependency_overrides[get_depot] = lambda: depot
    app.dependency_overrides[utilisateur_courant] = lambda: "u1"
    try:
        r = TestClient(app, headers=JETON).get("/journal")
        assert r.status_code == 403 and extrait in r.json()["detail"]
    finally:
        app.dependency_overrides.clear()


def test_horodatage_futur_ramene_a_maintenant(clients):
    # L'en-tête n'est pas signé : une date en 2099 ne doit pas bloquer les vrais événements suivants
    r = envoyer("SALE_NEW", vente(), horodatage="2099-01-01T00:00:00+00:00")
    assert r.status_code == 200
    assert clients[0]["abonnement_maj_le"] < "2099"
