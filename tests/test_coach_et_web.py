from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from supabase_auth.errors import AuthApiError

from app.auth import utilisateur_courant
from app.db import get_supabase
from app.main import app
from tests.conftest import JETON

ID_CLIENT = "11111111-1111-1111-1111-111111111111"
ID_COMPTE = "22222222-2222-2222-2222-222222222222"


class FausseTable:
    def __init__(self, db, nom):
        self.db, self.nom, self.filtres, self.maj, self.suppression = db, nom, [], None, False

    def select(self, _):
        return self

    def update(self, donnees):
        self.maj = donnees
        return self

    def delete(self):
        self.suppression = True
        return self

    def eq(self, champ, valeur):
        self.filtres.append((champ, valeur))
        return self

    def limit(self, _):
        return self

    def execute(self):
        lignes = [l for l in self.db.tables[self.nom] if all(l.get(c) == v for c, v in self.filtres)]
        if self.maj:
            for l in lignes:
                l.update(self.maj)
        if self.suppression:
            self.db.tables[self.nom] = [l for l in self.db.tables[self.nom] if l not in lignes]
        return SimpleNamespace(data=lignes)


def erreur_auth(code, statut=400):
    return AuthApiError("refus", statut, code)


class FauxSupabase:
    """Supabase simulé : tables en mémoire et API Auth (admin, invitation, réinitialisation)."""

    def __init__(self, erreur_invitation=None, erreur_reinit=None, erreur_suppression=None, comptes=()):
        self.tables = {
            "coachs": [{"user_id": "coach1"}],
            "clients": [{"id": ID_CLIENT, "email": "c@x.fr", "user_id": None}],
        }
        self.comptes = list(comptes)  # comptes Auth existants : SimpleNamespace(id=..., email=...)
        self.invitations, self.reinitialisations, self.suppressions = [], [], []

        def inviter(email, options):
            if erreur_invitation:
                raise erreur_invitation
            self.invitations.append((email, options))
            return SimpleNamespace(user=SimpleNamespace(id="nouvel-utilisateur"))

        def lister(page=None, per_page=None):
            debut = (page - 1) * per_page
            return self.comptes[debut:debut + per_page]

        def lire(uid):
            compte = next((c for c in self.comptes if c.id == uid), None)
            if not compte:
                raise erreur_auth("user_not_found", 404)
            return SimpleNamespace(user=compte)

        def supprimer(uid):
            if erreur_suppression:
                raise erreur_suppression
            self.suppressions.append(uid)

        def reinitialiser(email, options):
            if erreur_reinit:
                raise erreur_reinit
            self.reinitialisations.append((email, options))

        self.auth = SimpleNamespace(
            admin=SimpleNamespace(invite_user_by_email=inviter, list_users=lister, get_user_by_id=lire,
                                  delete_user=supprimer),
            reset_password_for_email=reinitialiser,
        )

    def table(self, nom):
        return FausseTable(self, nom)


URL = f"/coach/clients/{ID_CLIENT}/invitation"


@pytest.fixture
def contexte(monkeypatch):
    monkeypatch.setenv("APP_URL", "https://sportoop.exemple")

    def preparer(user="coach1", **options):
        db = FauxSupabase(**options)
        app.dependency_overrides[get_supabase] = lambda: db
        app.dependency_overrides[utilisateur_courant] = lambda: user
        return db, TestClient(app, headers=JETON)
    yield preparer
    app.dependency_overrides.clear()


def fiche(db):
    return db.tables["clients"][0]


# --- Invitation -------------------------------------------------------------

def test_invitation_cree_et_lie_le_compte(contexte):
    db, api = contexte()
    r = api.post(URL)
    assert r.status_code == 200
    assert r.json() == {"status": "success", "action": "invitation", "email": "c@x.fr"}
    assert db.invitations == [("c@x.fr", {"redirect_to": "https://sportoop.exemple/app/"})]
    assert fiche(db)["user_id"] == "nouvel-utilisateur"


def test_app_url_avec_slash_final(contexte, monkeypatch):
    monkeypatch.setenv("APP_URL", "https://sportoop.exemple/")
    db, api = contexte()
    api.post(URL)
    assert db.invitations[0][1] == {"redirect_to": "https://sportoop.exemple/app/"}


def test_sans_app_url_https_du_proxy(contexte, monkeypatch):
    monkeypatch.delenv("APP_URL")
    db, api = contexte()
    api.post(URL, headers={"X-Forwarded-Proto": "https"})
    assert db.invitations[0][1] == {"redirect_to": "https://testserver/app/"}


def test_invitation_reservee_au_coach(contexte):
    db, api = contexte(user="client-lambda")
    assert api.post(URL).status_code == 403
    assert db.invitations == []


def test_invitation_client_inconnu(contexte):
    _, api = contexte()
    assert api.post("/coach/clients/33333333-3333-3333-3333-333333333333/invitation").status_code == 404


def test_compte_existant_non_lie_jamais_rattache(contexte):
    # Compte créé hors invitation (inscription publique) : mot de passe inconnu, donc pas de rattachement
    db, api = contexte(comptes=[SimpleNamespace(id="pirate", email="C@X.fr")])
    r = api.post(URL)
    assert r.status_code == 409 and "Authentication → Users" in r.json()["detail"]
    assert db.invitations == [] and fiche(db)["user_id"] is None


def test_recherche_du_compte_sur_plusieurs_pages(contexte, monkeypatch):
    monkeypatch.setattr("app.routes_coach.COMPTES_PAR_PAGE", 2)
    autres = [SimpleNamespace(id=f"u{i}", email=f"u{i}@x.fr") for i in range(5)]
    db, api = contexte(comptes=[*autres, SimpleNamespace(id="pirate", email="c@x.fr")])
    assert api.post(URL).status_code == 409


@pytest.mark.parametrize("erreur, extrait", [
    (erreur_auth("email_address_not_authorized"), "SMTP"),
    (erreur_auth("over_email_send_rate_limit", 429), "limite d'envoi"),
    (erreur_auth("unexpected_failure", 500), "SMTP"),
    (RuntimeError("réseau"), "ne répond pas"),
])
def test_envoi_refuse_par_supabase(contexte, erreur, extrait):
    db, api = contexte(erreur_invitation=erreur)
    r = api.post(URL)
    assert r.status_code == 502 and extrait in r.json()["detail"]
    assert "refusé par Supabase" in r.json()["detail"] or extrait == "ne répond pas"
    assert fiche(db)["user_id"] is None


def test_email_pris_pendant_l_invitation(contexte):
    db, api = contexte(erreur_invitation=erreur_auth("email_exists", 422))
    assert api.post(URL).status_code == 409
    assert fiche(db)["user_id"] is None


# --- Compte déjà rattaché : lien de connexion -------------------------------

def test_compte_deja_lie_recoit_un_lien_de_connexion(contexte):
    db, api = contexte(comptes=[SimpleNamespace(id=ID_COMPTE, email="connexion@x.fr")])
    fiche(db)["user_id"] = ID_COMPTE
    r = api.post(URL)
    assert r.status_code == 200
    assert r.json() == {"status": "success", "action": "lien_connexion", "email": "connexion@x.fr"}
    assert db.reinitialisations == [("connexion@x.fr", {"redirect_to": "https://sportoop.exemple/app/"})]
    assert db.invitations == []


def test_lien_de_connexion_refuse(contexte):
    db, api = contexte(erreur_reinit=erreur_auth("email_address_not_authorized"))
    fiche(db)["user_id"] = ID_COMPTE
    r = api.post(URL)
    assert r.status_code == 502 and "SMTP" in r.json()["detail"]


# --- Suppression (droit à l'effacement) -------------------------------------

URL_FICHE = f"/coach/clients/{ID_CLIENT}"


def test_suppression_fiche_et_compte(contexte):
    db, api = contexte()
    fiche(db)["user_id"] = ID_COMPTE
    assert api.delete(URL_FICHE).status_code == 204
    assert db.suppressions == [ID_COMPTE] and db.tables["clients"] == []


def test_suppression_fiche_sans_compte(contexte):
    db, api = contexte()
    assert api.delete(URL_FICHE).status_code == 204
    assert db.suppressions == [] and db.tables["clients"] == []


def test_suppression_ne_touche_jamais_un_compte_coach(contexte):
    db, api = contexte()
    fiche(db)["user_id"] = "coach1"
    assert api.delete(URL_FICHE).status_code == 204
    assert db.suppressions == [] and db.tables["clients"] == []


def test_suppression_compte_deja_absent(contexte):
    db, api = contexte(erreur_suppression=erreur_auth("user_not_found", 404))
    fiche(db)["user_id"] = ID_COMPTE
    assert api.delete(URL_FICHE).status_code == 204
    assert db.tables["clients"] == []


def test_suppression_refusee_rien_n_est_efface(contexte):
    db, api = contexte(erreur_suppression=erreur_auth("unexpected_failure", 500))
    fiche(db)["user_id"] = ID_COMPTE
    assert api.delete(URL_FICHE).status_code == 502
    assert len(db.tables["clients"]) == 1


def test_suppression_reservee_au_coach(contexte):
    db, api = contexte(user="client-lambda")
    assert api.delete(URL_FICHE).status_code == 403
    assert len(db.tables["clients"]) == 1


def test_suppression_client_inconnu(contexte):
    _, api = contexte()
    assert api.delete("/coach/clients/33333333-3333-3333-3333-333333333333").status_code == 404


def test_suppression_efface_le_compte_non_rattache_du_meme_email(contexte):
    # Invitation envoyée mais rattachement échoué : le compte garde l'e-mail, il est effacé avec la fiche
    db, api = contexte(comptes=[SimpleNamespace(id="orphelin", email="C@X.fr")])
    assert api.delete(URL_FICHE).status_code == 204
    assert db.suppressions == ["orphelin"] and db.tables["clients"] == []


def test_suppression_garde_un_compte_rattache_a_une_autre_fiche(contexte):
    db, api = contexte(comptes=[SimpleNamespace(id="autre", email="c@x.fr")])
    db.tables["clients"].append({"id": "autre-fiche", "email": "d@x.fr", "user_id": "autre"})
    assert api.delete(URL_FICHE).status_code == 204
    assert db.suppressions == [] and [c["id"] for c in db.tables["clients"]] == ["autre-fiche"]


def test_suppression_garde_un_compte_coach_du_meme_email(contexte):
    db, api = contexte(comptes=[SimpleNamespace(id="coach1", email="c@x.fr")])
    assert api.delete(URL_FICHE).status_code == 204
    assert db.suppressions == [] and db.tables["clients"] == []


def test_suppression_recherche_du_compte_impossible_rien_n_est_efface(contexte):
    db, api = contexte()

    def panne(page=None, per_page=None):
        raise ConnectionError("Supabase Auth injoignable")
    db.auth.admin.list_users = panne
    reponse = api.delete(URL_FICHE)
    assert reponse.status_code == 502 and "rien n'a été effacé" in reponse.json()["detail"]
    assert db.suppressions == [] and len(db.tables["clients"]) == 1


# --- Frontend servi par FastAPI ---------------------------------------------

def test_pages_web_servies():
    api = TestClient(app)
    assert "ADRM Sportoop" in api.get("/app/").text
    assert "Espace coach" in api.get("/app/coach/").text
    assert api.get("/app/client.js").status_code == 200
    assert api.get("/app", follow_redirects=False).headers["location"] == "/app/"


def test_aucune_cle_secrete_dans_le_frontend():
    from pathlib import Path
    for fichier in Path("web").rglob("*"):
        if fichier.is_file() and fichier.suffix in {".js", ".html", ".json", ".webmanifest"}:
            texte = fichier.read_text(encoding="utf-8")
            assert "service_role" not in texte.replace("Ne JAMAIS mettre ici la clé service_role", ""), fichier
            assert "sb_secret_" not in texte, fichier
