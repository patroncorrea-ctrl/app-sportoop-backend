import hmac
import os

from fastapi import Header, HTTPException, status


def verifier_secret_webhook(x_webhook_secret: str | None = Header(default=None)) -> None:
    """Refuse tout appel de webhook sans le secret partagé envoyé par Make (header X-Webhook-Secret)."""
    attendu = os.getenv("WEBHOOK_SECRET")
    if not attendu:
        # Sans secret configuré côté serveur, on refuse tout plutôt que de laisser passer.
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Webhook non configuré.")
    if not x_webhook_secret or not hmac.compare_digest(x_webhook_secret.encode(), attendu.encode()):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Secret webhook invalide.")
