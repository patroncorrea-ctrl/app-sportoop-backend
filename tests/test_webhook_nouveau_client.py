import pytest
from fastapi.testclient import TestClient

from app.db import get_supabase
from app.main import app

SECRET = "secret-de-test"


class FauxSupabase:
    """Remplace le client Supabase : enregistre les appels à table().upsert().execute()."""

    def __init__(self):
        self.appels = []

    def table(self, nom):
        self._table = nom
        return self

    def upsert(self, donnees, **options):
        self.appels.append((self._table, donnees, options))
        self._donnees = donnees
        return self

    def execute(self):
        return type("Reponse", (), {"data": [self._donnees]})()


@pytest.fixture
def faux_db():
    db = FauxSupabase()
    app.dependency_overrides[get_supabase] = lambda: db
    yield db
    app.dependency_overrides.clear()


@pytest.fixture
def client(monkeypatch, faux_db):
    monkeypatch.setenv("WEBHOOK_SECRET", SECRET)
    return TestClient(app)


PAYLOAD = {"nom": "  Jean Test ", "email": " Jean@Exemple.FR ", "target_kcal": 2000}


def test_statut(client):
    r = client.get("/")
    assert r.status_code == 200
    assert r.json()["status"] == "API en ligne"


def test_sans_secret_refuse(client, faux_db):
    r = client.post("/webhooks/nouveau-client", json=PAYLOAD)
    assert r.status_code == 401
    assert faux_db.appels == []


def test_mauvais_secret_refuse(client, faux_db):
    r = client.post("/webhooks/nouveau-client", json=PAYLOAD, headers={"X-Webhook-Secret": "faux"})
    assert r.status_code == 401
    assert faux_db.appels == []


def test_secret_serveur_absent_refuse(monkeypatch, faux_db):
    monkeypatch.delenv("WEBHOOK_SECRET", raising=False)
    r = TestClient(app).post("/webhooks/nouveau-client", json=PAYLOAD, headers={"X-Webhook-Secret": "x"})
    assert r.status_code == 503
    assert faux_db.appels == []


def test_upsert_sur_email(client, faux_db):
    r = client.post("/webhooks/nouveau-client", json=PAYLOAD, headers={"X-Webhook-Secret": SECRET})
    assert r.status_code == 200
    table, donnees, options = faux_db.appels[0]
    assert table == "clients"
    assert donnees == {"nom": "Jean Test", "email": "jean@exemple.fr", "target_kcal": 2000}
    assert options == {"on_conflict": "email"}


@pytest.mark.parametrize(
    "modif",
    [{"email": "pas-un-email"}, {"nom": ""}, {"target_kcal": 50}, {"target_kcal": 99999}],
)
def test_donnees_invalides(client, faux_db, modif):
    r = client.post(
        "/webhooks/nouveau-client", json={**PAYLOAD, **modif}, headers={"X-Webhook-Secret": SECRET}
    )
    assert r.status_code == 422
    assert faux_db.appels == []


# --- Champs complets du formulaire d'onboarding -----------------------------

def envoyer(client, donnees):
    return client.post("/webhooks/nouveau-client", json=donnees, headers={"X-Webhook-Secret": SECRET})


def test_formulaire_complet_avec_consentement(client, faux_db):
    r = envoyer(client, {**PAYLOAD, "target_proteines": 160, "jours_sport": "lundi, Mercredi ;vendredi",
                         "contraintes_sante": " Genou fragile ", "consentement_sante": True})
    assert r.status_code == 200
    assert "Genou" not in r.text  # la donnée de santé n'est jamais renvoyée
    _, donnees, _ = faux_db.appels[0]
    assert donnees["jours_sport"] == ["Lundi", "Mercredi", "Vendredi"]
    assert donnees["contraintes_sante"] == "Genou fragile"
    assert donnees["target_proteines"] == 160 and "consentement_sante_le" in donnees


def test_sante_sans_consentement_refusee(client, faux_db):
    r = envoyer(client, {**PAYLOAD, "contraintes_sante": "Asthme"})
    assert r.status_code == 422 and faux_db.appels == []


def test_champs_absents_non_ecrases(client, faux_db):
    envoyer(client, {"nom": "Jean", "email": "jean@exemple.fr"})
    _, donnees, _ = faux_db.appels[0]
    assert donnees == {"nom": "Jean", "email": "jean@exemple.fr"}


def test_jour_invalide(client, faux_db):
    assert envoyer(client, {**PAYLOAD, "jours_sport": ["Funday"]}).status_code == 422
