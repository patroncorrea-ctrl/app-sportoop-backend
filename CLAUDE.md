# CLAUDE.md — ADRM SPORTOOP

Ce fichier est lu automatiquement par Claude Code à chaque session. Il décrit le projet, les règles de travail et la feuille de route.

## Règles de travail (à respecter en priorité)

- Réponds et commente en **français**.
- **Ne jamais committer de secret** (clés Supabase, Gemini, token Telegram, secret webhook). Tout passe par des variables d'environnement ; un `.env.example` documente les noms.
- **Demander validation avant** : toute opération destructive en base (DROP, DELETE, TRUNCATE, ALTER qui supprime des données), tout push sur `main`, tout changement de configuration Railway.
- Les migrations SQL sont écrites dans `supabase/migrations/AAAAMMJJ_description.sql` et **montrées au propriétaire avant exécution** dans Supabase.
- Commits petits et explicites, un sujet par commit. Travailler sur une branche par phase (`feat/securite`, `feat/nutrition`…).
- Proposer un plan avant toute tâche de plus de ~50 lignes de code.
- Données de santé = catégorie sensible RGPD (art. 9) : ne jamais les logger, ne jamais les envoyer à un service tiers sans que ce soit prévu et documenté.

## Vision

Application web/mobile responsive de coaching sportif et nutritionnel personnalisé.

- **Nutrition** : décompte en temps réel des kcal et macros (protéines, glucides, lipides), ajout par scan de code-barres (Open Food Facts), par photo d'assiette (IA Gemini, présentée comme *estimation corrigeable*) ou manuellement.
- **8 blocs de repas chronologiques** (valeurs exactes pour `type_repas`) :
  1. `PETIT_DEJEUNER` 2. `COLLATION_MATIN` 3. `DEJEUNER` 4. `COLLATION_APRES_MIDI` 5. `DINER` 6. `PRE_WORKOUT` (avant sport) 7. `WORKOUT` (pendant sport) 8. `POST_WORKOUT` (après sport)
- **Sport** : programmes vidéo, calendrier de séances modifiable à distance par le coach, boutons d'action dynamiques, règles de redirection automatique après validation d'une séance.
- **Onboarding** : vente Systeme.io → Google Forms (contraintes, disponibilités, objectifs) → Make → API FastAPI → Supabase.

## Stack

- Frontend : HTML5 + Tailwind CSS (dark mode natif), futur PWA / Capacitor. Maquettes client et coach déjà réalisées.
- Backend : Python FastAPI, hébergé sur Railway. Démarrage : `uvicorn main:app --host 0.0.0.0 --port $PORT`
- Dépôt : `patroncorrea-ctrl/app-sportoop-backend` (ancien nom `app-sportoop`, encore utilisé par le remote git local)
- Base : Supabase (PostgreSQL), région UE (`eu-west-1`).
- Services : Make.com (webhooks), Open Food Facts (gratuit), Google Gemini (vision), Systeme.io (ventes, abonnements, mails).

## Variables d'environnement

| Nom | Usage |
|---|---|
| `SUPABASE_URL` | URL du projet Supabase |
| `SUPABASE_KEY` | Clé **service_role** (backend uniquement, jamais côté frontend) |
| `WEBHOOK_SECRET` | Secret partagé envoyé par Make dans le header `X-Webhook-Secret` |
| `GEMINI_API_KEY` | Clé API Google Gemini (niveau **payant** : le gratuit peut réutiliser les photos) |
| `GEMINI_MODEL` | Modèle Gemini (défaut `gemini-3.8-flash`) |
| `PHOTO_IA_ACTIVE` | `true` pour activer l'estimation par photo (après mise à jour de la politique de confidentialité) |
| `APP_URL` | Adresse publique, sans `/app` ni `/` final (liens d'invitation) ; défaut : l'hôte de la requête. Production : `https://app-sportoop-backend-production.up.railway.app` |
| `SYSTEMEIO_WEBHOOK_SECRET` | Secret du webhook Systeme.io (signature HMAC-SHA256, header `X-Webhook-Signature`) |
| `SYSTEMEIO_PRICE_PLAN_IDS` | Facultatif : `pricePlan.id` des offres qui donnent accès, séparés par des virgules ; vide = toutes les ventes |

En local, `main.py` charge le fichier `.env` de la racine s'il existe (python-dotenv, installé par `requirements-dev.txt`,
sans écraser les variables déjà définies). En production (Railway), pas de `.env` : onglet Variables du service.

## Base Supabase

- Projet `frhmfyvrcdzohsgdjjwr`, région `eu-west-1` (UE), PostgreSQL 17.
- Migrations appliquées le 2026-09-25 : `20260925_schema_v2.sql`, `20260925_durcissement_rls.sql`, `20260925_abonnement_systemeio.sql`,
  `20260925_securite_rls_v2.sql` (validée par le propriétaire, appliquée à 18h22 UTC et vérifiée : contrainte, colonnes, trigger, policies)
  (fonctions RLS `prive.est_coach()` / `prive.mon_client_id()` dans le schéma `prive`, non exposé).
- Détail de `20260925_securite_rls_v2.sql` (APPLIQUÉE : le code de `fix/audit` peut être déployé), dont ce code dépend (statut `EN_ATTENTE`, colonne `formulaire_recu_le`). Contenu : statut `EN_ATTENTE` autorisé,
  colonne `clients.formulaire_recu_le`, `prive.mon_client_id()` et `client_lit_sa_fiche` limités aux fiches `ACTIF`,
  plus aucune écriture directe du client (`client_gere_ses_repas` / `client_gere_ses_aliments` remplacées par
  `client_lit_ses_repas` / `client_lit_ses_aliments` en SELECT, `client_valide_une_seance` supprimée), règles et boutons
  lisibles seulement avec une fiche `ACTIF`, colonne `clients.statut_modifie_le` posée par le trigger
  `clients_date_statut` (fonction `prive.dater_changement_statut()`) à chaque changement réel de statut, quelle qu'en
  soit l'origine, et non modifiable à la main. C'est elle, et non `abonnement_maj_le` (événements Systeme.io
  seulement), qui date la revue de conservation. L'espace coach l'affiche si la colonne existe.
- Security Advisor : **1 alerte** `auth_leaked_password_protection` (protection des mots de passe compromis), à régler
  dans le tableau de bord Supabase Auth ; option réservée au plan Pro (organisation actuellement sur le plan gratuit).
- État au 2026-09-25 : 0 client, 1 coach. Inscriptions publiques Supabase encore ouvertes (à fermer, voir
  `docs/mise-en-production.md`).

## Statuts d'abonnement (`clients.statut_abonnement`)

| Statut | Origine | Accès |
|---|---|---|
| `ACTIF` | achat Systeme.io (`SALE_NEW`), fiche créée par le coach (valeur par défaut), ou choix du coach | oui |
| `EN_ATTENTE` | fiche créée par le formulaire d'onboarding avant tout achat, ou choix du coach | non |
| `RESILIE` | résiliation / remboursement Systeme.io (`SALE_CANCELED`), ou choix du coach | non |

Seul `ACTIF` donne accès : API (`client_courant` renvoie 403 sinon) et base (RLS via `prive.mon_client_id()`, après la
migration `securite_rls_v2`). Le coach change le statut depuis l'espace coach (update Supabase via la RLS `coach_tout`).

## Schéma v1 d'origine (avant les migrations ci-dessus)

```sql
CREATE TABLE public.clients (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT UNIQUE NOT NULL,
    nom TEXT NOT NULL,
    target_kcal INT DEFAULT 1830,
    target_glucides INT DEFAULT 137,
    target_proteines INT DEFAULT 183,
    target_lipides INT DEFAULT 61,
    jours_sport JSONB DEFAULT '["Lundi", "Mercredi", "Vendredi"]'::jsonb,
    contraintes_sante TEXT,
    created_at TIMESTAMPTZ DEFAULT timezone('utc', now()) NOT NULL
);

CREATE TABLE public.seances (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID REFERENCES public.clients(id) ON DELETE CASCADE,
    titre TEXT NOT NULL,
    jour_semaine TEXT NOT NULL,
    duree TEXT,
    video_url TEXT,
    statut TEXT DEFAULT 'A_FAIRE',
    ordre INT DEFAULT 1,
    created_at TIMESTAMPTZ DEFAULT timezone('utc', now()) NOT NULL
);

CREATE TABLE public.journal_repas (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID REFERENCES public.clients(id) ON DELETE CASCADE,
    date_repas DATE DEFAULT CURRENT_DATE NOT NULL,
    type_repas TEXT NOT NULL,
    target_kcal INT DEFAULT 0,
    consigne_coach TEXT,
    created_at TIMESTAMPTZ DEFAULT timezone('utc', now()) NOT NULL
);

CREATE TABLE public.aliments_scannes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    repas_id UUID REFERENCES public.journal_repas(id) ON DELETE CASCADE,
    nom_aliment TEXT NOT NULL,
    kcal INT NOT NULL,
    glucides NUMERIC(5,1) DEFAULT 0,
    proteines NUMERIC(5,1) DEFAULT 0,
    lipides NUMERIC(5,1) DEFAULT 0,
    methode_ajout TEXT DEFAULT 'scan_barcode',
    created_at TIMESTAMPTZ DEFAULT timezone('utc', now()) NOT NULL
);
```

## Code actuel

- `main.py` (racine) : point d'entrée Railway, réexporte `app.main:app` ; charge `.env` en local si python-dotenv est installé.
- `app/main.py` : `GET /` (statut), frontend servi sur `/app/`, `POST /webhooks/nouveau-client` (Make/Google Forms, protégé par
  `X-Webhook-Secret`). Formulaire reçu **une seule fois** par e-mail : e-mail inconnu → fiche `EN_ATTENTE` +
  `formulaire_recu_le` ; fiche existante jamais complétée (vente ou coach) → complétée, statut inchangé ; déjà reçu → 409.
  Formats Make tolérés (chaîne vide = non répondu, nombres en texte, jours en texte ou liste, consentement « Oui » /
  libellé coché) ; `contraintes_sante` refusées (422) sans consentement reconnu.
- `app/limites.py` : middleware `ProtectionRequetes` (401 sans jeton sur les routes non publiques, 413 au-delà de 64 Ko,
  9 Mo pour la photo) et limitation de débit en mémoire (photo 6/min et 40/jour par client ; produits 30/min par client,
  90/min pour le serveur) → 429 + `Retry-After`. Compteurs par processus : une seule instance Railway.
- `app/constantes.py` : statuts d'abonnement, 8 types de repas, jours, fuseau, type `Nom`.
- `app/db.py` : client Supabase unique (`get_supabase`, dépendance FastAPI, surchargeable en test) ; 503 si non configuré.
- `app/security.py` : vérification du secret webhook (comparaison à temps constant ; 503 si `WEBHOOK_SECRET` absent).
- `app/auth.py` : `utilisateur_courant` (vérifie le JWT Supabase via `auth.get_user`) et `client_courant` (fiche `clients` liée
  et abonnement `ACTIF`, 403 sinon avec le motif « en attente » / « résilié »).
- `app/depot.py` : `DepotNutrition`, tout l'accès Supabase de la nutrition (contrôle d'appartenance inclus, car la clé service_role contourne la RLS).
- `app/routes_nutrition.py` : `GET /journal?date=` (8 blocs, totaux, restant), `GET /produits/{code_barres}` (Open Food Facts),
  `POST /journal/{date}/{type_repas}/aliments` (valeurs pour 100 g + grammes, ou par portion), `PATCH`/`DELETE /aliments/{id}`.
- `app/openfoodfacts.py` : client Open Food Facts (seul le code-barres est transmis).
- `app/gemini.py` + `POST /journal/{date}/{type_repas}/photo` : estimation IA d'une photo, aliments enregistrés avec
  `est_estimation = true` (corrigeables via `PATCH`). Photo ni stockée ni journalisée. Désactivé si `PHOTO_IA_ACTIVE` ≠ `true`.
- `app/depot_sport.py` + `app/routes_sport.py` : `GET /seances/semaine?date=`, `POST /seances/{id}/validation`
  (historique dans `seances_realisees`, renvoie la redirection la plus spécifique), `GET /boutons?emplacement=`.
- `app/systemeio.py` : `POST /webhooks/systemeio` (`SALE_NEW` → client créé ou passé `ACTIF`, `SALE_CANCELED` → `RESILIE`).
  `abonnement_maj_le` = horodatage de l'événement ; un événement plus ancien est ignoré. Filtre `SYSTEMEIO_PRICE_PLAN_IDS`.
  Un client non `ACTIF` reçoit 403 sur toutes les routes client.
- `app/routes_coach.py` (coach uniquement, jeton Supabase) :
  - `POST /coach/clients/{id}/invitation` : fiche sans compte → invitation Supabase + liaison `user_id`
    (`"action": "invitation"`) ; compte déjà lié → lien de connexion / choix du mot de passe (`"action": "lien_connexion"`).
    Envoi refusé par Supabase (pas de SMTP, limite d'envoi) → 502 avec message clair ; 409 seulement si l'e-mail est pris
    par un autre compte non lié (jamais rattaché automatiquement).
  - `DELETE /coach/clients/{id}` → 204 : supprime le compte Supabase Auth lié et la fiche (cascade des données). Effacement RGPD.
- `web/` : frontend sans build (HTML + Tailwind CDN + supabase-js). `index.html`/`client.js` = application client (PWA),
  `coach/` = espace coach (accès direct Supabase, protégé par la RLS), `config.js` = URL + clé **publishable** uniquement.
- `docs/mise-en-production.md` : actions réservées au propriétaire, dans l'ordre (Supabase Auth, Railway, migration,
  fusion, Systeme.io, Make, statuts, limites, revue de conservation).
- `docs/politique-confidentialite.md` : projet RGPD à compléter et faire valider.
- `requirements.txt` épinglé ; `requirements-dev.txt` ajoute pytest et python-dotenv.
- Tests : `.venv\Scripts\python.exe -m pytest -q` (Supabase simulé, aucun appel réseau ; `tests/conftest.py` remet les
  limiteurs de débit à zéro).

## Production

- En ligne : **https://app-sportoop-backend-production.up.railway.app** (API sur `/`, application client sur `/app/`,
  espace coach sur `/app/coach/`). Railway déploie `main` (actuellement la fusion de la PR #1, commit `6140486`).
- Au 2026-09-25 : **aucune variable d'environnement définie sur Railway** (routes de données et webhooks en échec),
  compte Railway en période d'essai (à passer en formule payante). Étapes restantes : `docs/mise-en-production.md`.

## Problèmes connus (issus de l'audit)

Réglés en Phase 1 (branche `feat/securite`) : 1, 3, 10 (dépendance), 11.
Réglés en Phase 2 (branche `feat/schema-v2`, appliqué en base) : 2, 5, 6, 7, 8, 9 ; 12 partiellement (région UE confirmée, colonne `consentement_sante_le`).
Réglé en Phase 3 (branche `feat/onboarding`) : 4. Reste pour la Phase 3 : webhook Make/Google Forms complet (liste des questions à fournir).

Branches empilées (chacune part de la précédente) : `feat/outillage` → `feat/securite` → `feat/schema-v2` → `feat/nutrition` → `feat/sport` → `feat/onboarding` → `feat/frontend` → `feat/onboarding-formulaire` (contient tout, fusionnée dans `main` par la PR #1).

Audit du 2026-09-25 (branche `fix/audit`, non fusionnée) : statut `EN_ATTENTE` et formulaire reçu une seule fois,
filtre des offres et ordre des événements Systeme.io, invitation avec diagnostic des refus d'envoi, suppression d'un
client (effacement RGPD), RLS limitée aux abonnements `ACTIF` et en lecture seule pour les clients (migration
`20260925_securite_rls_v2.sql`, appliquée), limitation de débit et tailles maximales, chargement du `.env`
en local. Reste côté tableau de bord (propriétaire) : fermer les inscriptions publiques Supabase, configurer un SMTP
personnalisé, protection des mots de passe (plan Pro) ou longueur minimale, Redirect URLs, variables Railway.
Purge des données après la durée de conservation : revues manuelles (pas de tâche planifiée), mensuelle pour les
réponses Google Forms, au moins semestrielle pour les fiches (requête sur `statut_modifie_le`, voir
`docs/mise-en-production.md` étape 10). Formulaire : adresse e-mail vérifiée par Google (pas de question « E-mail »),
scénario Make en « Data is confidential ».
Railway : projet `happy-simplicity`, service `app-sportoop-backend`, déploie `main` du dépôt `patroncorrea-ctrl/app-sportoop-backend` (ancien nom `app-sportoop`).

1. Webhook `/webhooks/nouveau-client` **non authentifié** : n'importe qui peut créer des clients.
2. **RLS désactivé** sur toutes les tables ; `clients` non lié à `auth.users`.
3. Insert simple sur email → erreur si le client existe déjà (utiliser un upsert).
4. Aucune gestion de la **résiliation** d'abonnement Systeme.io.
5. `type_repas`, `statut`, `jour_semaine`, `methode_ajout` en texte libre, sans contrainte.
6. Pas d'unicité `(client_id, date_repas, type_repas)` sur `journal_repas`.
7. `seances` liées à un jour de semaine, sans historique daté des séances réalisées.
8. `aliments_scannes` sans quantité (grammes) ni code-barres.
9. Pas de tables pour les règles de redirection et boutons dynamiques du coach.
10. `google-generativeai` est déprécié → migrer vers `google-genai`. Vérifier le modèle Gemini le plus récent.
11. Versions non épinglées dans `requirements.txt`.
12. RGPD : `contraintes_sante` = donnée de santé → consentement explicite dans le formulaire, région UE, politique de confidentialité.

## Feuille de route

- **Phase 0 — Outillage** : hooks Telegram opérationnels, `.gitignore`, `.env.example`, structure de dossiers (`app/`, `supabase/migrations/`, `tests/`).
- **Phase 1 — Sécurité & fiabilité** : secret webhook, upsert, client Supabase unique, versions épinglées, tests pytest, déploiement Railway validé.
- **Phase 2 — Schéma v2** : contraintes CHECK, unicités, grammes + code-barres, historique des séances, tables règles/boutons, liaison `auth.users`, RLS + policies.
- **Phase 3 — Onboarding complet** : webhook Make/Google Forms (tous les champs), webhook Systeme.io (achat + résiliation).
- **Phase 4 — Nutrition** : endpoints repas/aliments, Open Food Facts, Gemini vision (estimation corrigeable).
- **Phase 5 — Frontend** : brancher les maquettes client et coach sur l'API avec l'authentification Supabase.
