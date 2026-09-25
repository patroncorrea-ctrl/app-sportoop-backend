import pytest
from fastapi.testclient import TestClient
from postgrest.exceptions import APIError

from app.db import get_supabase
from app.main import app, consentement_donne

SECRET = "secret-de-test"


class FausseTable:
    """Table « clients » en mémoire : select/eq/is_/limit, insert (e-mail unique), update."""

    def __init__(self, db):
        self.db, self.op, self.filtres, self.donnees = db, None, [], None

    def select(self, _champs):
        self.op = "select"
        return self

    def insert(self, donnees):
        self.op, self.donnees = "insert", donnees
        return self

    def update(self, donnees):
        self.op, self.donnees = "update", donnees
        return self

    def eq(self, champ, valeur):
        self.filtres.append(lambda l: l.get(champ) == valeur)
        return self

    def is_(self, champ, valeur):
        assert valeur == "null"
        self.filtres.append(lambda l: l.get(champ) is None)
        return self

    def limit(self, _n):
        return self

    def execute(self):
        self.db.appels.append((self.op, self.donnees))
        if self.op == "insert":
            if self.db.concurrent:  # fiche créée par un autre envoi entre la lecture et l'insertion
                self.db.lignes.append(self.db.concurrent)
                self.db.concurrent = None
            if any(l["email"] == self.donnees["email"] for l in self.db.lignes):
                raise APIError({"code": "23505", "message": "duplicate key"})
            ligne = {"id": f"id{len(self.db.lignes)}", **self.donnees}
            self.db.lignes.append(ligne)
            return type("R", (), {"data": [ligne]})()
        cibles = [l for l in self.db.lignes if all(f(l) for f in self.filtres)]
        if self.op == "update":
            for l in cibles:
                l.update(self.donnees)
        return type("R", (), {"data": cibles})()


class FauxSupabase:
    def __init__(self):
        self.lignes, self.appels, self.concurrent = [], [], None

    def table(self, nom):
        assert nom == "clients"
        return FausseTable(self)

    def ecritures(self):
        return [a for a in self.appels if a[0] in ("insert", "update")]


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


def envoyer(client, donnees):
    return client.post("/webhooks/nouveau-client", json=donnees, headers={"X-Webhook-Secret": SECRET})


def test_statut(client):
    r = client.get("/")
    assert r.status_code == 200
    assert r.json()["status"] == "API en ligne"


# --- Secret -----------------------------------------------------------------

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


def test_base_non_configuree_503_json(monkeypatch):
    monkeypatch.setenv("WEBHOOK_SECRET", SECRET)
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_KEY", raising=False)
    get_supabase.cache_clear()
    r = envoyer(TestClient(app), PAYLOAD)
    assert r.status_code == 503 and r.json() == {"detail": "Base de données non configurée."}


# --- Création, complétion, second envoi -------------------------------------

def test_nouveau_client_cree_en_attente(client, faux_db):
    r = envoyer(client, PAYLOAD)
    assert r.status_code == 200 and r.json()["action"] == "fiche_creee"
    ligne = faux_db.lignes[0]
    assert (ligne["nom"], ligne["email"], ligne["target_kcal"]) == ("Jean Test", "jean@exemple.fr", 2000)
    assert ligne["statut_abonnement"] == "EN_ATTENTE" and ligne["formulaire_recu_le"]


def test_fiche_de_la_vente_completee_sans_toucher_au_statut(client, faux_db):
    faux_db.lignes.append({"id": "v1", "email": "jean@exemple.fr", "nom": "jean", "statut_abonnement": "ACTIF",
                           "formulaire_recu_le": None, "target_kcal": 1830})
    r = envoyer(client, PAYLOAD)
    assert r.status_code == 200 and r.json()["action"] == "fiche_completee"
    ligne = faux_db.lignes[0]
    assert (ligne["nom"], ligne["target_kcal"], ligne["statut_abonnement"]) == ("Jean Test", 2000, "ACTIF")
    assert ligne["formulaire_recu_le"] and len(faux_db.lignes) == 1


def test_formulaire_deja_recu_refuse(client, faux_db):
    faux_db.lignes.append({"id": "v1", "email": "jean@exemple.fr", "nom": "Jean", "statut_abonnement": "ACTIF",
                           "formulaire_recu_le": "2026-09-01T10:00:00+00:00", "target_kcal": 2200})
    r = envoyer(client, {**PAYLOAD, "target_kcal": 800, "contraintes_sante": "aucune", "consentement_sante": True})
    assert r.status_code == 409
    assert faux_db.ecritures() == [] and faux_db.lignes[0]["target_kcal"] == 2200


def test_fiche_creee_pendant_l_envoi_est_completee(client, faux_db):
    faux_db.concurrent = {"id": "v1", "email": "jean@exemple.fr", "nom": "jean", "statut_abonnement": "ACTIF",
                          "formulaire_recu_le": None}
    r = envoyer(client, PAYLOAD)
    assert r.status_code == 200 and r.json()["action"] == "fiche_completee"
    assert len(faux_db.lignes) == 1 and faux_db.lignes[0]["target_kcal"] == 2000


@pytest.mark.parametrize(
    "modif",
    [{"email": "pas-un-email"}, {"nom": ""}, {"nom": "   "}, {"target_kcal": 50}, {"target_kcal": 99999},
     {"target_kcal": "beaucoup"}],
)
def test_donnees_invalides(client, faux_db, modif):
    r = envoyer(client, {**PAYLOAD, **modif})
    assert r.status_code == 422
    assert faux_db.appels == []


# --- Champs complets du formulaire d'onboarding -----------------------------

def test_formulaire_complet_avec_consentement(client, faux_db):
    r = envoyer(client, {**PAYLOAD, "target_proteines": 160, "jours_sport": "lundi, Mercredi ;vendredi",
                         "contraintes_sante": " Genou fragile ", "consentement_sante": True})
    assert r.status_code == 200
    assert "Genou" not in r.text  # la donnée de santé n'est jamais renvoyée
    ligne = faux_db.lignes[0]
    assert ligne["jours_sport"] == ["Lundi", "Mercredi", "Vendredi"]
    assert ligne["contraintes_sante"] == "Genou fragile"
    assert ligne["target_proteines"] == 160 and "consentement_sante_le" in ligne


def test_sante_sans_consentement_refusee(client, faux_db):
    r = envoyer(client, {**PAYLOAD, "contraintes_sante": "Asthme"})
    assert r.status_code == 422 and faux_db.appels == []


def test_champs_absents_non_ecrases(client, faux_db):
    faux_db.lignes.append({"id": "v1", "email": "jean@exemple.fr", "nom": "jean", "formulaire_recu_le": None,
                           "target_kcal": 1830, "jours_sport": ["Lundi"]})
    envoyer(client, {"nom": "Jean", "email": "jean@exemple.fr"})
    _, donnees = faux_db.ecritures()[0]
    assert set(donnees) == {"nom", "formulaire_recu_le"}
    assert faux_db.lignes[0]["target_kcal"] == 1830 and faux_db.lignes[0]["jours_sport"] == ["Lundi"]


def test_jour_invalide(client, faux_db):
    assert envoyer(client, {**PAYLOAD, "jours_sport": ["Funday"]}).status_code == 422


# --- Formats transmis par Make ----------------------------------------------

def test_reponses_vides_de_make_ignorees(client, faux_db):
    r = envoyer(client, {"nom": "Jean", "email": "jean@exemple.fr", "target_kcal": "", "target_proteines": " ",
                         "jours_sport": "", "contraintes_sante": "  ", "consentement_sante": ""})
    assert r.status_code == 200
    ligne = faux_db.lignes[0]
    for champ in ("target_kcal", "target_proteines", "jours_sport", "contraintes_sante", "consentement_sante_le"):
        assert champ not in ligne


def test_nombres_en_texte(client, faux_db):
    envoyer(client, {**PAYLOAD, "target_kcal": "2 100", "target_proteines": "150,4", "target_lipides": 60.0})
    ligne = faux_db.lignes[0]
    assert (ligne["target_kcal"], ligne["target_proteines"], ligne["target_lipides"]) == (2100, 150, 60)


def test_jours_en_liste(client, faux_db):
    envoyer(client, {**PAYLOAD, "jours_sport": ["lundi", " MERCREDI ", "lundi", ""]})
    assert faux_db.lignes[0]["jours_sport"] == ["Lundi", "Mercredi"]


@pytest.mark.parametrize("valeur", [
    True, "true", "Oui", "oui", "1", 1, "J'accepte que mes données de santé soient traitées",
    "J’accepte le traitement", ["J'accepte que mes données de santé soient traitées"], "Je consens",
])
def test_consentement_accepte(client, faux_db, valeur):
    r = envoyer(client, {**PAYLOAD, "contraintes_sante": "Genou", "consentement_sante": valeur})
    assert r.status_code == 200 and faux_db.lignes[0]["contraintes_sante"] == "Genou"


@pytest.mark.parametrize("valeur", [False, "false", "Non", "", [], 0, "Je n'accepte pas", "peut-être", None])
def test_consentement_absent_ou_ambigu(client, faux_db, valeur):
    r = envoyer(client, {**PAYLOAD, "contraintes_sante": "Genou", "consentement_sante": valeur})
    assert r.status_code == 422 and faux_db.appels == []


def test_consentement_donne_valeurs_brutes():
    assert consentement_donne(["", "J'accepte"]) and not consentement_donne(["", None])
    assert not consentement_donne({"oui": True})
