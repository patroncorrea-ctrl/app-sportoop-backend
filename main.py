# Point d'entrée Railway : `uvicorn main:app --host 0.0.0.0 --port $PORT`
from pathlib import Path

# Développement local : charge le fichier .env s'il existe, sans écraser les variables déjà définies.
# python-dotenv n'est installé qu'en développement (requirements-dev.txt) : en production (Railway),
# l'import échoue et seules les variables du service sont utilisées.
try:
    from dotenv import load_dotenv
except ImportError:
    pass
else:
    load_dotenv(Path(__file__).resolve().parent / ".env")

from app.main import app  # noqa: E402,F401
