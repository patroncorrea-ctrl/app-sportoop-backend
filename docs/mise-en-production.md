# Mise en production — ADRM Sportoop

Liste des actions qui ne peuvent être faites que par le propriétaire (secrets, production, comptes tiers).
Tout le reste (code, base, tests) est prêt.

## 1. Railway (projet `happy-simplicity`, service `app-sportoop-backend`)

Onglet **Variables** du service :

| Variable | Valeur |
|---|---|
| `SUPABASE_URL` | `https://frhmfyvrcdzohsgdjjwr.supabase.co` |
| `SUPABASE_KEY` | clé **service_role** (Supabase → Project Settings → API Keys). Secrète. |
| `WEBHOOK_SECRET` | secret aléatoire : `python -c "import secrets; print(secrets.token_urlsafe(32))"` |
| `SYSTEMEIO_WEBHOOK_SECRET` | secret affiché par Systeme.io à la création du webhook (étape 4) |
| `APP_URL` | l'adresse publique, ex. `https://app-sportoop-backend-production.up.railway.app` |
| `PHOTO_IA_ACTIVE` | `false` (voir étape 6) |

Onglet **Settings → Networking** : **Generate Domain** (adresse publique `…up.railway.app`).

## 2. GitHub : fusion dans `main`

Railway déploie automatiquement `main`. Les branches sont empilées ; la dernière contient tout :
ouvrir une pull request `feat/onboarding-formulaire` → `main` et la fusionner **après** l'étape 1.

Vérification après déploiement : `https://<adresse>/` doit répondre `{"status":"API en ligne",…}`
et `https://<adresse>/app/` afficher l'écran de connexion.

## 3. Supabase

- **Authentication → URL Configuration** : *Site URL* = `https://<adresse>/app/` et ajouter
  `https://<adresse>/app/` et `https://<adresse>/app/coach/` dans *Redirect URLs* (liens d'invitation et de
  réinitialisation de mot de passe).
- **Authentication → Providers → Email** : activer *Leaked password protection* (alerte du Security Advisor).
- **Authentication → Emails** : personnaliser en français les modèles « Invite user » et « Reset password ».
- Pour de vrais volumes d'invitations, configurer un SMTP (l'envoi intégré de Supabase est limité).

## 4. Systeme.io

Automatisations → Webhooks → créer un webhook vers `https://<adresse>/webhooks/systemeio`,
événements **New sale** et **Sale canceled**. Copier le secret dans `SYSTEMEIO_WEBHOOK_SECRET` (étape 1).

## 5. Make (Google Forms → API)

Module **HTTP → Make a request** :
- URL : `https://<adresse>/webhooks/nouveau-client`, méthode `POST`, corps JSON ;
- header `X-Webhook-Secret` = valeur de `WEBHOOK_SECRET` ;
- corps (seuls `nom` et `email` sont obligatoires) :

```json
{
  "nom": "{{Prénom}} {{Nom}}",
  "email": "{{E-mail}}",
  "target_kcal": 1830,
  "target_proteines": 183,
  "target_glucides": 137,
  "target_lipides": 61,
  "jours_sport": "{{Jours disponibles}}",
  "contraintes_sante": "{{Contraintes de santé}}",
  "consentement_sante": true
}
```

`jours_sport` accepte une liste ou un texte « Lundi, Mercredi ». **`consentement_sante` doit refléter une case à
cocher obligatoire du formulaire** (« J'accepte que mes données de santé soient traitées pour adapter mon
programme ») : sans elle, les contraintes de santé sont refusées (erreur 422).

## 6. Estimation par photo (facultatif)

1. Créer une clé Gemini sur un projet Google **avec facturation activée** (le niveau gratuit peut réutiliser les
   contenus envoyés).
2. Publier la politique de confidentialité (`docs/politique-confidentialite.md`, à compléter).
3. Railway : `GEMINI_API_KEY` = la clé, puis `PHOTO_IA_ACTIVE` = `true`.

## 7. Premier client

Espace coach `https://<adresse>/app/coach/` → **+ Nouveau client** (ou arrivée automatique via Systeme.io / Make)
→ fiche du client → **Envoyer l'invitation**. Le client reçoit un e-mail, choisit son mot de passe et accède à
`https://<adresse>/app/` (installable sur l'écran d'accueil du téléphone).
