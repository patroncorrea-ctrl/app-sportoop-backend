import uuid
from datetime import date

import pytest
from fastapi.testclient import TestClient

from app import routes_sport
from app.auth import client_courant
from app.depot_sport import get_depot_sport
from app.main import app
from app.routes_sport import choisir_redirection

S_LUNDI = str(uuid.uuid4())
S_MERCREDI = str(uuid.uuid4())
S_AUTRE_CLIENT = str(uuid.uuid4())


class FauxDepotSport:
    def __init__(self):
        self.seances = [
            {"id": S_MERCREDI, "client_id": "c1", "titre": "Jambes", "jour_semaine": "Mercredi",
             "duree": "45 min", "video_url": None, "ordre": 1},
            {"id": S_LUNDI, "client_id": "c1", "titre": "Haut du corps", "jour_semaine": "Lundi",
             "duree": "40 min", "video_url": "https://v/1", "ordre": 1},
            {"id": S_AUTRE_CLIENT, "client_id": "c2", "titre": "Autre", "jour_semaine": "Lundi",
             "duree": None, "video_url": None, "ordre": 1},
        ]
        self.realisations = {}
        self.regles = []
        self.boutons = []

    def seances_du_client(self, client_id):
        return [s for s in self.seances if s["client_id"] == client_id]

    def seance_du_client(self, seance_id, client_id):
        return next((s for s in self.seances if s["id"] == seance_id and s["client_id"] == client_id), None)

    def realisations_entre(self, client_id, debut, fin):
        return [r for r in self.realisations.values()
                if r["client_id"] == client_id and debut.isoformat() <= r["date_realisee"] <= fin.isoformat()]

    def enregistrer_realisation(self, donnees):
        self.realisations[(donnees["seance_id"], donnees["date_realisee"])] = donnees
        return donnees

    def regles_actives(self, client_id, declencheur):
        return [r for r in self.regles if r["declencheur"] == declencheur and r["client_id"] in (None, client_id)]

    def boutons_actifs(self, client_id, emplacement):
        return [b for b in self.boutons if b["client_id"] in (None, client_id)
                and (emplacement is None or b["emplacement"] == emplacement)]


@pytest.fixture
def depot(monkeypatch):
    d = FauxDepotSport()
    app.dependency_overrides[get_depot_sport] = lambda: d
    app.dependency_overrides[client_courant] = lambda: {"id": "c1"}
    monkeypatch.setattr(routes_sport, "aujourdhui", lambda: date(2026, 9, 25))  # un vendredi
    yield d
    app.dependency_overrides.clear()


@pytest.fixture
def api(depot):
    return TestClient(app)


# --- Programme de la semaine ------------------------------------------------

def test_semaine_du_lundi_au_dimanche(api, depot):
    depot.realisations[(S_LUNDI, "2026-09-21")] = {
        "client_id": "c1", "seance_id": S_LUNDI, "date_realisee": "2026-09-21", "statut": "FAIT"}
    s = api.get("/seances/semaine", params={"date": "2026-09-24"}).json()
    assert (s["du"], s["au"]) == ("2026-09-21", "2026-09-27")
    assert [j["jour_semaine"] for j in s["jours"]][0] == "Lundi"
    lundi, mardi, mercredi = s["jours"][:3]
    assert [x["titre"] for x in lundi["seances"]] == ["Haut du corps"]   # pas la séance de c2
    assert lundi["seances"][0]["realisation"]["statut"] == "FAIT"
    assert mardi["seances"] == []
    assert mercredi["seances"][0]["realisation"] is None


def test_semaine_par_defaut_aujourdhui(api):
    assert api.get("/seances/semaine").json()["du"] == "2026-09-21"


# --- Validation -------------------------------------------------------------

def test_validation_enregistre_et_sans_regle(api, depot):
    r = api.post(f"/seances/{S_LUNDI}/validation", json={"date": "2026-09-21", "ressenti": 4})
    assert r.status_code == 200
    assert r.json()["redirection"] is None
    ligne = depot.realisations[(S_LUNDI, "2026-09-21")]
    assert (ligne["statut"], ligne["ressenti"], ligne["titre"]) == ("FAIT", 4, "Haut du corps")


def test_validation_date_par_defaut(api, depot):
    api.post(f"/seances/{S_LUNDI}/validation", json={})
    assert (S_LUNDI, "2026-09-25") in depot.realisations


def test_validation_future_refusee(api, depot):
    r = api.post(f"/seances/{S_LUNDI}/validation", json={"date": "2026-09-26"})
    assert r.status_code == 422 and depot.realisations == {}


def test_validation_seance_d_un_autre_client(api, depot):
    assert api.post(f"/seances/{S_AUTRE_CLIENT}/validation", json={}).status_code == 404
    assert depot.realisations == {}


def test_validation_ressenti_invalide(api):
    assert api.post(f"/seances/{S_LUNDI}/validation", json={"ressenti": 9}).status_code == 422


def test_validation_renvoie_la_redirection(api, depot):
    depot.regles = [
        {"declencheur": "SEANCE_VALIDEE", "client_id": None, "seance_id": None,
         "cible_type": "ECRAN", "cible": "accueil", "priorite": 1},
        {"declencheur": "SEANCE_MANQUEE", "client_id": None, "seance_id": None,
         "cible_type": "ECRAN", "cible": "motivation", "priorite": 1},
    ]
    assert api.post(f"/seances/{S_LUNDI}/validation", json={}).json()["redirection"] == {
        "cible_type": "ECRAN", "cible": "accueil"}
    assert api.post(f"/seances/{S_LUNDI}/validation", json={"statut": "MANQUE"}).json()["redirection"] == {
        "cible_type": "ECRAN", "cible": "motivation"}


# --- Choix de la règle ------------------------------------------------------

def regle(cible, client_id=None, seance_id=None, priorite=1):
    return {"client_id": client_id, "seance_id": seance_id, "cible_type": "ECRAN", "cible": cible,
            "priorite": priorite}


def test_regle_la_plus_specifique_gagne():
    regles = [regle("globale"), regle("seance", seance_id="s1"), regle("client", client_id="c1"),
              regle("client+seance", client_id="c1", seance_id="s1")]
    assert choisir_redirection(regles, "c1", "s1")["cible"] == "client+seance"
    assert choisir_redirection(regles[:3], "c1", "s1")["cible"] == "client"
    assert choisir_redirection(regles[:2], "c1", "s1")["cible"] == "seance"
    assert choisir_redirection(regles[:1], "c1", "s1")["cible"] == "globale"


def test_regle_priorite_a_specificite_egale():
    assert choisir_redirection([regle("b", priorite=2), regle("a", priorite=1)], "c1", "s1")["cible"] == "a"


def test_regle_d_une_autre_seance_ignoree():
    assert choisir_redirection([regle("x", seance_id="s2")], "c1", "s1") is None


# --- Boutons ----------------------------------------------------------------

def test_boutons_globaux_et_propres(api, depot):
    depot.boutons = [
        {"client_id": None, "emplacement": "ACCUEIL", "libelle": "Programme"},
        {"client_id": "c1", "emplacement": "ACCUEIL", "libelle": "Mon bilan"},
        {"client_id": "c2", "emplacement": "ACCUEIL", "libelle": "Pas pour moi"},
        {"client_id": None, "emplacement": "SEANCE", "libelle": "Vidéo"},
    ]
    assert [b["libelle"] for b in api.get("/boutons", params={"emplacement": "ACCUEIL"}).json()] == [
        "Programme", "Mon bilan"]
    assert len(api.get("/boutons").json()) == 3
