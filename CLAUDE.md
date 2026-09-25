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
- Dépôt : `patroncorrea-ctrl/app-sportoop`
- Base : Supabase (PostgreSQL), région UE à confirmer.
- Services : Make.com (webhooks), Open Food Facts (gratuit), Google Gemini (vision), Systeme.io (ventes, abonnements, mails).

## Variables d'environnement

| Nom | Usage |
|---|---|
| `SUPABASE_URL` | URL du projet Supabase |
| `SUPABASE_KEY` | Clé **service_role** (backend uniquement, jamais côté frontend) |
| `WEBHOOK_SECRET` | Secret partagé envoyé par Make dans le header `X-Webhook-Secret` |
| `GEMINI_API_KEY` | Clé API Google Gemini |

## Base Supabase

- Projet `frhmfyvrcdzohsgdjjwr`, région `eu-west-1` (UE), PostgreSQL 17.
- Migrations appliquées le 2026-09-25 : `20260925_schema_v2.sql`, `20260925_durcissement_rls.sql`
  (fonctions RLS `prive.est_coach()` / `prive.mon_client_id()` dans le schéma `prive`, non exposé).
- Security Advisor : 0 alerte après migration.

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

- `main.py` (racine) : point d'entrée Railway, réexporte `app.main:app`.
- `app/main.py` : `GET /` (statut) et `POST /webhooks/nouveau-client` (protégé par `X-Webhook-Secret`, upsert sur `email`).
- `app/db.py` : client Supabase unique (`get_supabase`, dépendance FastAPI, surchargeable en test).
- `app/security.py` : vérification du secret webhook (comparaison à temps constant ; 503 si `WEBHOOK_SECRET` absent).
- `requirements.txt` épinglé ; `requirements-dev.txt` ajoute pytest/httpx.
- Tests : `.venv\Scripts\python.exe -m pytest -q` (Supabase simulé, aucun appel réseau).

## Problèmes connus (issus de l'audit)

Réglés en Phase 1 (branche `feat/securite`) : 1, 3, 10 (dépendance), 11.
Réglés en Phase 2 (branche `feat/schema-v2`, appliqué en base) : 2, 5, 6, 7, 8, 9 ; 12 partiellement (région UE confirmée, colonne `consentement_sante_le`).

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
