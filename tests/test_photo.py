from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app import gemini
from app.auth import utilisateur_courant
from app.depot import get_depot
from app.main import app
from app.routes_nutrition import estimateur_disponible
from tests.test_nutrition import FauxDepot

ASSIETTE = [
    {"nom_aliment": "Riz", "quantite_g": 180.26, "kcal": 234.6, "proteines": 4.87, "glucides": 51.2, "lipides": 0.5},
    {"nom_aliment": "Saumon", "quantite_g": 120, "kcal": 250, "proteines": 24, "glucides": 0, "lipides": 16.4},
]


class FauxEstimateur:
    def __init__(self, resultat=None, erreur=None):
        self.resultat, self.erreur, self.appels = resultat, erreur, 0

    def estimer(self, image, mime_type):
        self.appels += 1
        if self.erreur:
            raise self.erreur
        return self.resultat


@pytest.fixture
def depot():
    d = FauxDepot()
    app.dependency_overrides[get_depot] = lambda: d
    app.dependency_overrides[utilisateur_courant] = lambda: "u1"
    yield d
    app.dependency_overrides.clear()


def envoyer(estimateur, contenu=b"\xff\xd8image", mime="image/jpeg"):
    app.dependency_overrides[estimateur_disponible] = lambda: estimateur
    return TestClient(app).post(
        "/journal/2026-09-25/DEJEUNER/photo", files={"photo": ("assiette.jpg", contenu, mime)})


def test_aliments_estimes_enregistres_comme_estimation(depot):
    r = envoyer(FauxEstimateur(ASSIETTE))
    assert r.status_code == 201
    riz, saumon = r.json()["aliments"]
    assert (riz["kcal"], riz["proteines"], riz["quantite_g"]) == (235, 4.9, 180.3)
    assert riz["methode_ajout"] == "photo_ia" and riz["est_estimation"] is True
    assert "corrigez" in r.json()["avertissement"]
    assert len(depot.aliments) == 2 and len(depot.repas) == 1


def test_correction_leve_le_marqueur_estimation(depot):
    riz = envoyer(FauxEstimateur(ASSIETTE)).json()["aliments"][0]
    r = TestClient(app).patch(f"/aliments/{riz['id']}", json={"quantite_g": 90})
    assert r.json()["est_estimation"] is False and r.json()["kcal"] == 117


def test_format_refuse_sans_appel_ia(depot):
    e = FauxEstimateur(ASSIETTE)
    assert envoyer(e, mime="application/pdf").status_code == 415
    assert e.appels == 0


def test_image_trop_lourde(depot, monkeypatch):
    monkeypatch.setattr("app.routes_nutrition.TAILLE_MAX_IMAGE", 10)
    e = FauxEstimateur(ASSIETTE)
    assert envoyer(e, contenu=b"x" * 11).status_code == 413
    assert e.appels == 0


def test_rien_reconnu(depot):
    assert envoyer(FauxEstimateur([])).status_code == 422
    assert depot.aliments == {}


def test_panne_ia(depot):
    r = envoyer(FauxEstimateur(erreur=gemini.EstimationImpossible("Service d'estimation indisponible.")))
    assert r.status_code == 502 and depot.aliments == {}


def test_service_desactive_par_defaut(depot, monkeypatch):
    monkeypatch.delenv("PHOTO_IA_ACTIVE", raising=False)
    monkeypatch.setenv("GEMINI_API_KEY", "cle")
    r = TestClient(app).post("/journal/2026-09-25/DEJEUNER/photo",
                             files={"photo": ("a.jpg", b"img", "image/jpeg")})
    assert r.status_code == 503


def test_active_sans_cle(monkeypatch):
    monkeypatch.setenv("PHOTO_IA_ACTIVE", "true")
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    with pytest.raises(gemini.PhotoIADesactivee):
        gemini.get_estimateur()


# --- Estimateur Gemini (SDK simulé) -----------------------------------------

def _estimateur_avec(texte=None, erreur=None):
    est = gemini.EstimateurGemini.__new__(gemini.EstimateurGemini)
    from google.genai import types
    est._types, est.modele = types, "modele-test"

    def generate_content(**kwargs):
        if erreur:
            raise erreur
        assert kwargs["model"] == "modele-test"
        assert kwargs["config"].response_mime_type == "application/json"
        return SimpleNamespace(text=texte)

    est.client = SimpleNamespace(models=SimpleNamespace(generate_content=generate_content))
    return est


def test_gemini_reponse_valide():
    texte = '{"aliments": [{"nom_aliment": "Pomme", "quantite_g": 150, "kcal": 78, ' \
            '"proteines": 0.4, "glucides": 21, "lipides": 0.3}]}'
    assert _estimateur_avec(texte).estimer(b"img", "image/jpeg")[0]["nom_aliment"] == "Pomme"


def test_gemini_reponse_incoherente():
    texte = '{"aliments": [{"nom_aliment": "X", "quantite_g": -5, "kcal": 1, "proteines": 0, ' \
            '"glucides": 0, "lipides": 0}]}'
    with pytest.raises(gemini.EstimationImpossible):
        _estimateur_avec(texte).estimer(b"img", "image/jpeg")


def test_gemini_erreur_api():
    with pytest.raises(gemini.EstimationImpossible):
        _estimateur_avec(erreur=RuntimeError("quota")).estimer(b"img", "image/jpeg")
