import pytest

from app import limites

# En-tête exigé par le middleware sur toute route client / coach (la vérification du jeton
# lui-même est ensuite simulée en surchargeant la dépendance utilisateur_courant ou client_courant).
JETON = {"Authorization": "Bearer jeton-de-test"}


@pytest.fixture(autouse=True)
def compteurs_de_debit_remis_a_zero():
    """Les limiteurs de débit sont globaux au processus : chaque test repart de zéro."""
    for limiteur in (limites.DEBIT_PHOTO, limites.DEBIT_PRODUITS, limites.DEBIT_PRODUITS_GLOBAL):
        limiteur.reinitialiser()
    yield
