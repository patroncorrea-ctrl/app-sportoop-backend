"""Recherche de produits par code-barres dans Open Food Facts (seul le code-barres est transmis)."""

import httpx

URL_PRODUIT = "https://world.openfoodfacts.org/api/v2/product/{code}.json"
CHAMPS = "code,product_name,product_name_fr,brands,nutriments"
USER_AGENT = "ADRM-SPORTOOP/0.1"
KJ_PAR_KCAL = 4.184


class ProduitIntrouvable(Exception):
    pass


class ServiceIndisponible(Exception):
    pass


def _nombre(valeur) -> float | None:
    try:
        return round(float(valeur), 1)
    except (TypeError, ValueError):
        return None


def extraire_produit(code: str, produit: dict) -> dict:
    """Normalise la réponse Open Food Facts : valeurs pour 100 g, None si inconnues."""
    n = produit.get("nutriments") or {}
    kcal = _nombre(n.get("energy-kcal_100g"))
    if kcal is None and _nombre(n.get("energy_100g")) is not None:
        kcal = round(float(n["energy_100g"]) / KJ_PAR_KCAL, 1)  # énergie fournie seulement en kJ
    return {
        "code_barres": code,
        "nom": produit.get("product_name_fr") or produit.get("product_name") or None,
        "marque": produit.get("brands") or None,
        "pour_100g": {
            "kcal": kcal,
            "proteines": _nombre(n.get("proteins_100g")),
            "glucides": _nombre(n.get("carbohydrates_100g")),
            "lipides": _nombre(n.get("fat_100g")),
        },
    }


def chercher_produit(code: str, client: httpx.Client | None = None) -> dict:
    if client is None:
        with httpx.Client(timeout=8.0) as c:
            return chercher_produit(code, c)
    try:
        r = client.get(
            URL_PRODUIT.format(code=code),
            params={"fields": CHAMPS},
            headers={"User-Agent": USER_AGENT},
        )
    except httpx.HTTPError as e:
        raise ServiceIndisponible() from e
    if r.status_code == 404:
        raise ProduitIntrouvable()
    if r.status_code != 200:
        raise ServiceIndisponible()
    corps = r.json()
    if corps.get("status") != 1 or not corps.get("product"):
        raise ProduitIntrouvable()
    return extraire_produit(code, corps["product"])
