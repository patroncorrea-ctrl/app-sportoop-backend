import uuid
from types import SimpleNamespace

import httpx
import pytest
from fastapi.testclient import TestClient

from app import openfoodfacts
from app.auth import client_courant, utilisateur_courant
from app.db import get_supabase
from app.depot import get_depot
from app.main import app

CLIENT = {
    "id": "c1", "nom": "Jean", "target_kcal": 2000,
    "target_proteines": 150, "target_glucides": 200, "target_lipides": 60,
}


class FauxDepot:
    """Dépôt nutrition en mémoire, avec le même contrat que DepotNutrition."""

    def __init__(self):
        self.repas = {}     # id -> {id, client_id, date_repas, type_repas, ...}
        self.aliments = {}  # id -> ligne aliments_scannes

    def client_par_user_id(self, user_id):
        return CLIENT if user_id == "u1" else None

    def repas_du_jour(self, client_id, jour):
        res = []
        for r in self.repas.values():
            if r["client_id"] == client_id and r["date_repas"] == jour.isoformat():
                aliments = [a for a in self.aliments.values() if a["repas_id"] == r["id"]]
                res.append({**r, "aliments": aliments})
        return res

    def obtenir_ou_creer_repas(self, client_id, jour, type_repas):
        for r in self.repas.values():
            if (r["client_id"], r["date_repas"], r["type_repas"]) == (client_id, jour.isoformat(), type_repas):
                return r["id"]
        rid = str(uuid.uuid4())
        self.repas[rid] = {"id": rid, "client_id": client_id, "date_repas": jour.isoformat(),
                           "type_repas": type_repas, "target_kcal": 0, "consigne_coach": None}
        return rid

    def ajouter_aliment(self, donnees):
        aid = str(uuid.uuid4())
        self.aliments[aid] = {"id": aid, "created_at": f"t{len(self.aliments)}", **donnees}
        return self.aliments[aid]

    def aliment_du_client(self, aliment_id, client_id):
        a = self.aliments.get(aliment_id)
        if a and self.repas[a["repas_id"]]["client_id"] == client_id:
            return dict(a)
        return None

    def modifier_aliment(self, aliment_id, champs):
        self.aliments[aliment_id].update(champs)
        return self.aliments[aliment_id]

    def supprimer_aliment(self, aliment_id):
        del self.aliments[aliment_id]


@pytest.fixture
def depot():
    d = FauxDepot()
    app.dependency_overrides[get_depot] = lambda: d
    app.dependency_overrides[utilisateur_courant] = lambda: "u1"
    yield d
    app.dependency_overrides.clear()


@pytest.fixture
def api(depot):
    return TestClient(app)


POULET = {"nom_aliment": "Poulet", "quantite_g": 150, "kcal": 120, "proteines": 23, "glucides": 0, "lipides": 2.5}


def ajouter(api, aliment=POULET, jour="2026-09-25", type_repas="DEJEUNER"):
    return api.post(f"/journal/{jour}/{type_repas}/aliments", json=aliment)


# --- Ajout ------------------------------------------------------------------

def test_ajout_calcule_au_prorata_des_grammes(api):
    r = ajouter(api)
    assert r.status_code == 201
    a = r.json()
    assert (a["kcal"], a["proteines"], a["lipides"]) == (180, 34.5, 3.8)
    assert a["quantite_g"] == 150 and a["est_estimation"] is False


def test_ajout_valeurs_par_portion(api):
    r = ajouter(api, {"nom_aliment": "Banane", "base": "portion", "kcal": 105, "glucides": 27})
    assert r.status_code == 201
    assert (r.json()["kcal"], r.json()["glucides"]) == (105, 27)


def test_meme_bloc_reutilise(api, depot):
    ajouter(api)
    ajouter(api)
    assert len(depot.repas) == 1 and len(depot.aliments) == 2


@pytest.mark.parametrize("aliment, type_repas", [
    ({**POULET, "quantite_g": None}, "DEJEUNER"),               # base 100g sans grammes
    ({**POULET, "kcal": 1200}, "DEJEUNER"),                     # impossible pour 100 g
    ({**POULET, "methode_ajout": "scan_barcode"}, "DEJEUNER"),  # scan sans code-barres
    ({**POULET, "code_barres": "12ab"}, "DEJEUNER"),            # code-barres invalide
    (POULET, "GOUTER"),                                         # bloc inexistant
])
def test_ajout_invalide(api, depot, aliment, type_repas):
    assert ajouter(api, aliment, type_repas=type_repas).status_code == 422
    assert depot.aliments == {}


# --- Journal ----------------------------------------------------------------

def test_journal_8_blocs_totaux_et_restant(api):
    ajouter(api)
    ajouter(api, {"nom_aliment": "Riz", "quantite_g": 200, "kcal": 130, "glucides": 28, "proteines": 2.7,
                  "lipides": 0.3}, type_repas="DINER")
    j = api.get("/journal", params={"date": "2026-09-25"}).json()
    assert [b["type_repas"] for b in j["repas"]] == [
        "PETIT_DEJEUNER", "COLLATION_MATIN", "DEJEUNER", "COLLATION_APRES_MIDI",
        "DINER", "PRE_WORKOUT", "WORKOUT", "POST_WORKOUT"]
    assert j["totaux"] == {"kcal": 440, "proteines": 39.9, "glucides": 56.0, "lipides": 4.4}
    assert j["restant"] == {"kcal": 1560, "proteines": 110.1, "glucides": 144.0, "lipides": 55.6}
    assert j["repas"][0]["aliments"] == [] and j["repas"][0]["repas_id"] is None


def test_journal_autre_jour_vide(api):
    ajouter(api)
    j = api.get("/journal", params={"date": "2026-09-26"}).json()
    assert j["totaux"]["kcal"] == 0


# --- Modification / suppression ---------------------------------------------

def test_modif_quantite_recalcule(api):
    a = ajouter(api).json()
    r = api.patch(f"/aliments/{a['id']}", json={"quantite_g": 300})
    assert r.status_code == 200
    assert (r.json()["kcal"], r.json()["proteines"]) == (360, 69.0)


def test_modif_valeurs_explicites_et_fin_estimation(api, depot):
    a = ajouter(api).json()
    depot.aliments[a["id"]]["est_estimation"] = True
    r = api.patch(f"/aliments/{a['id']}", json={"kcal": 200.4, "nom_aliment": " Poulet rôti "})
    assert r.json()["kcal"] == 200 and r.json()["nom_aliment"] == "Poulet rôti"
    assert r.json()["est_estimation"] is False


def test_modif_vide_refusee(api):
    a = ajouter(api).json()
    assert api.patch(f"/aliments/{a['id']}", json={}).status_code == 422


def test_suppression(api, depot):
    a = ajouter(api).json()
    assert api.delete(f"/aliments/{a['id']}").status_code == 204
    assert depot.aliments == {}


def test_aliment_d_un_autre_client_invisible(api, depot):
    a = ajouter(api).json()
    depot.repas[a["repas_id"]]["client_id"] = "autre"
    assert api.patch(f"/aliments/{a['id']}", json={"kcal": 1}).status_code == 404
    assert api.delete(f"/aliments/{a['id']}").status_code == 404


def test_id_malforme(api):
    assert api.delete("/aliments/pas-un-uuid").status_code == 422


# --- Authentification -------------------------------------------------------

class FauxAuth:
    def get_user(self, jeton):
        if jeton == "bon":
            return SimpleNamespace(user=SimpleNamespace(id="u1"))
        raise Exception("jeton invalide")


@pytest.fixture
def api_auth():
    d = FauxDepot()
    app.dependency_overrides[get_depot] = lambda: d
    app.dependency_overrides[get_supabase] = lambda: SimpleNamespace(auth=FauxAuth())
    yield TestClient(app)
    app.dependency_overrides.clear()


def test_sans_jeton(api_auth):
    assert api_auth.get("/journal").status_code == 401


def test_jeton_invalide(api_auth):
    assert api_auth.get("/journal", headers={"Authorization": "Bearer faux"}).status_code == 401


def test_jeton_valide(api_auth):
    r = api_auth.get("/journal", headers={"Authorization": "Bearer bon"})
    assert r.status_code == 200 and len(r.json()["repas"]) == 8


def test_compte_sans_fiche_client(api_auth):
    app.dependency_overrides[utilisateur_courant] = lambda: "inconnu"
    assert api_auth.get("/journal").status_code == 403


# --- Open Food Facts --------------------------------------------------------

def _off(handler):
    return httpx.Client(transport=httpx.MockTransport(handler))


def test_off_produit_trouve():
    def handler(req):
        assert req.url.path == "/api/v2/product/3017620422003.json"
        assert "SPORTOOP" in req.headers["User-Agent"]
        return httpx.Response(200, json={"status": 1, "product": {
            "product_name_fr": "Pâte à tartiner", "brands": "X",
            "nutriments": {"energy-kcal_100g": 539, "proteins_100g": 6.3,
                           "carbohydrates_100g": 57.5, "fat_100g": 30.9}}})
    p = openfoodfacts.chercher_produit("3017620422003", _off(handler))
    assert p["nom"] == "Pâte à tartiner"
    assert p["pour_100g"] == {"kcal": 539.0, "proteines": 6.3, "glucides": 57.5, "lipides": 30.9}


def test_off_energie_en_kj_seulement():
    p = openfoodfacts.extraire_produit("12345678", {"nutriments": {"energy_100g": 418.4}})
    assert p["pour_100g"]["kcal"] == 100.0 and p["pour_100g"]["proteines"] is None


def test_off_introuvable():
    with pytest.raises(openfoodfacts.ProduitIntrouvable):
        openfoodfacts.chercher_produit("12345678", _off(lambda r: httpx.Response(200, json={"status": 0})))


def test_off_panne():
    def handler(req):
        raise httpx.ConnectTimeout("délai")
    with pytest.raises(openfoodfacts.ServiceIndisponible):
        openfoodfacts.chercher_produit("12345678", _off(handler))


def test_route_produit(api, monkeypatch):
    monkeypatch.setattr(openfoodfacts, "chercher_produit",
                        lambda code: {"code_barres": code, "nom": "Test", "pour_100g": {}})
    assert api.get("/produits/12345678").json()["nom"] == "Test"
    assert api.get("/produits/abc").status_code == 422

    def introuvable(code):
        raise openfoodfacts.ProduitIntrouvable()
    monkeypatch.setattr(openfoodfacts, "chercher_produit", introuvable)
    assert api.get("/produits/12345678").status_code == 404
