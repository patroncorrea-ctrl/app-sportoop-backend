from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app.auth import utilisateur_courant
from app.db import get_supabase
from app.main import app


class FausseTable:
    def __init__(self, db, nom):
        self.db, self.nom, self.filtres, self.maj = db, nom, [], None

    def select(self, _):
        return self

    def update(self, donnees):
        self.maj = donnees
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
        return SimpleNamespace(data=lignes)


class FauxSupabase:
    def __init__(self, invitation_echoue=False):
        self.tables = {
            "coachs": [{"user_id": "coach1"}],
            "clients": [{"id": "11111111-1111-1111-1111-111111111111", "email": "c@x.fr", "user_id": None}],
        }
        self.invitations = []

        def inviter(email, options):
            if invitation_echoue:
                raise RuntimeError("déjà inscrit")
            self.invitations.append((email, options))
            return SimpleNamespace(user=SimpleNamespace(id="nouvel-utilisateur"))

        self.auth = SimpleNamespace(admin=SimpleNamespace(invite_user_by_email=inviter))

    def table(self, nom):
        return FausseTable(self, nom)


URL = "/coach/clients/11111111-1111-1111-1111-111111111111/invitation"


@pytest.fixture
def contexte():
    def preparer(user="coach1", **options):
        db = FauxSupabase(**options)
        app.dependency_overrides[get_supabase] = lambda: db
        app.dependency_overrides[utilisateur_courant] = lambda: user
        return db, TestClient(app)
    yield preparer
    app.dependency_overrides.clear()


def test_invitation_cree_et_lie_le_compte(contexte, monkeypatch):
    monkeypatch.setenv("APP_URL", "https://sportoop.exemple")
    db, api = contexte()
    r = api.post(URL)
    assert r.status_code == 200
    assert db.invitations == [("c@x.fr", {"redirect_to": "https://sportoop.exemple/app/"})]
    assert db.tables["clients"][0]["user_id"] == "nouvel-utilisateur"


def test_invitation_reservee_au_coach(contexte):
    db, api = contexte(user="client-lambda")
    assert api.post(URL).status_code == 403
    assert db.invitations == []


def test_invitation_client_deja_lie(contexte):
    db, api = contexte()
    db.tables["clients"][0]["user_id"] = "existant"
    assert api.post(URL).status_code == 409


def test_invitation_client_inconnu(contexte):
    _, api = contexte()
    assert api.post("/coach/clients/22222222-2222-2222-2222-222222222222/invitation").status_code == 404


def test_invitation_refusee_par_supabase(contexte):
    db, api = contexte(invitation_echoue=True)
    assert api.post(URL).status_code == 409
    assert db.tables["clients"][0]["user_id"] is None


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
