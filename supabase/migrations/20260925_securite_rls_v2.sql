-- Sécurité RLS v2 — ADRM SPORTOOP (suite de l'audit du 25/09/2026)
--
-- NON EXÉCUTÉE : à montrer au propriétaire, puis à exécuter dans Supabase (SQL Editor) AVANT de déployer
-- le code de la branche fix/audit (le webhook du formulaire écrit statut_abonnement = 'EN_ATTENTE' et lit
-- formulaire_recu_le : sans cette migration, il échoue). L'inverse est sans risque : le code actuellement
-- en production fonctionne avec cette migration (il n'écrit jamais EN_ATTENTE ni formulaire_recu_le, le
-- trigger ajouté ne fait que dater les changements de statut, et l'application client ne lit aucune table
-- en direct : tout passe par l'API, clé service_role).
--
-- Aucune donnée supprimée ni modifiée :
--   - la contrainte CHECK du statut est remplacée par une contrainte PLUS LARGE (toute ligne existante,
--     'ACTIF' ou 'RESILIE', la respecte : aucune perte possible) ;
--   - deux colonnes sont ajoutées ; seule statut_modifie_le est initialisée pour les fiches existantes
--     (table clients vide au 25/09/2026), aucune autre colonne n'est écrite ;
--   - un trigger date les changements de statut à venir (il n'écrit que statut_modifie_le) ;
--   - seules des POLICIES sont supprimées puis recréées (aucune ligne touchée).
-- Noms des policies et contraintes vérifiés le 25/09/2026 dans la vraie base (pg_policies, pg_constraint).
-- Pas de IF EXISTS : si un nom ne correspond pas, tout échoue et rien n'est appliqué (transaction).
--
-- Règles obtenues :
--   1. Statuts d'abonnement : ACTIF, EN_ATTENTE (fiche créée par le formulaire avant tout achat), RESILIE.
--      Seul ACTIF donne accès aux données, dans l'API (client_courant) comme en base (RLS).
--   2. Un client n'écrit JAMAIS directement en base : toutes ses écritures passent par l'API FastAPI
--      (clé service_role), qui applique les contrôles (bornes, dates, est_estimation, appartenance).
--      Côté base, le client n'a plus que des droits de LECTURE sur ses propres lignes.
--   3. Règles de redirection et boutons (y compris globaux) : lisibles seulement par un compte lié à une
--      fiche ACTIF, et non plus par n'importe quel compte authentifié.
--   4. Chaque changement de statut est daté par la base (statut_modifie_le), quelle qu'en soit l'origine
--      (achat, résiliation, formulaire, coach) : base de la revue des durées de conservation.
--   Le coach (policies coach_tout, inchangées) garde un accès complet, dont la modification du statut.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Statut EN_ATTENTE (contrainte élargie, valeur par défaut 'ACTIF' inchangée)
--    La fiche créée par le coach dans l'espace coach reste ACTIF par défaut.
-- ---------------------------------------------------------------------------
ALTER TABLE public.clients DROP CONSTRAINT clients_statut_abonnement_check;
ALTER TABLE public.clients ADD CONSTRAINT clients_statut_abonnement_check
    CHECK (statut_abonnement IN ('ACTIF','EN_ATTENTE','RESILIE'));

-- ---------------------------------------------------------------------------
-- 2. Date de première réception du formulaire d'onboarding
--    NULL = formulaire jamais reçu (fiche créée par une vente Systeme.io ou par le coach) : le formulaire
--    peut la compléter UNE fois. Renseignée = formulaire déjà reçu : le webhook répond 409, seul le coach
--    modifie ensuite la fiche.
-- ---------------------------------------------------------------------------
ALTER TABLE public.clients ADD COLUMN formulaire_recu_le TIMESTAMPTZ;

COMMENT ON COLUMN public.clients.statut_abonnement IS
    'ACTIF (accès), EN_ATTENTE (formulaire reçu, pas encore d''achat), RESILIE. Seul ACTIF donne accès.';
COMMENT ON COLUMN public.clients.formulaire_recu_le IS
    'Première réception du formulaire d''onboarding (Google Forms → Make). NULL = jamais reçu.';

-- ---------------------------------------------------------------------------
-- 3. Date du dernier changement de statut, posée par la base (revue de conservation des données)
--    abonnement_maj_le ne date que les événements Systeme.io (ordre des webhooks) : un changement fait par
--    le coach (espace coach, update via la RLS coach_tout) ne la modifie pas, et une fiche créée par le
--    coach ou par le formulaire n'en a pas. statut_modifie_le = date depuis laquelle le statut actuel est
--    en vigueur, quelle que soit l'origine du changement. Elle sert à la revue manuelle des durées de
--    conservation (docs/mise-en-production.md, étape 10) et s'affiche dans la fiche client (espace coach).
--    - INSERT : heure du serveur (toute valeur fournie est ignorée) ;
--    - UPDATE qui change réellement le statut : heure du serveur ;
--    - UPDATE sans changement de statut (ex. nouvel achat d'un client déjà ACTIF, résiliation d'une fiche
--      déjà RESILIE) : date conservée. Une écriture directe de la colonne est ignorée, y compris par le
--      coach : la date ne peut être ni antidatée (suppression trop tôt) ni repoussée.
--    Colonne laissée NULLABLE : une anomalie du trigger ne doit jamais bloquer un webhook ; la revue
--    liste à part les fiches sans date.
-- ---------------------------------------------------------------------------
ALTER TABLE public.clients ADD COLUMN statut_modifie_le TIMESTAMPTZ;

-- Fiches déjà présentes (aucune au 25/09/2026) : meilleure date connue. N'écrit que la nouvelle colonne ;
-- exécuté AVANT la création du trigger.
UPDATE public.clients SET statut_modifie_le = coalesce(abonnement_maj_le, created_at);

COMMENT ON COLUMN public.clients.statut_modifie_le IS
    'Date depuis laquelle le statut actuel est en vigueur (trigger clients_date_statut, heure du serveur). '
    'Base de la revue des durées de conservation. Non modifiable directement.';

-- Fonction de trigger dans le schéma prive (non exposé). SECURITY INVOKER : elle ne lit aucune table et
-- n'écrit que la ligne en cours d'écriture. Elle ne peut pas être appelée directement (« trigger functions
-- can only be called as triggers ») : droits par défaut conservés.
CREATE FUNCTION prive.dater_changement_statut() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        NEW.statut_modifie_le := now();
    ELSIF NEW.statut_abonnement IS DISTINCT FROM OLD.statut_abonnement THEN
        NEW.statut_modifie_le := now();
    ELSE
        NEW.statut_modifie_le := OLD.statut_modifie_le;
    END IF;
    RETURN NEW;
END;
$$;

-- UPDATE OF : le trigger ne se déclenche que si l'écriture touche le statut ou la date elle-même
-- (les mises à jour du nom, des objectifs, etc. ne le déclenchent pas).
CREATE TRIGGER clients_date_statut
    BEFORE INSERT OR UPDATE OF statut_abonnement, statut_modifie_le ON public.clients
    FOR EACH ROW EXECUTE FUNCTION prive.dater_changement_statut();

-- ---------------------------------------------------------------------------
-- 4. prive.mon_client_id() : id de la fiche seulement si l'abonnement est ACTIF
--    Point central : toutes les policies client (séances, historique, journal, aliments, règles, boutons)
--    renvoient ainsi 0 ligne à un client EN_ATTENTE ou RESILIE, même en appel direct à /rest/v1.
--    CREATE OR REPLACE conserve propriétaire et droits ; ils sont réaffirmés par prudence.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION prive.mon_client_id() RETURNS UUID
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT id FROM public.clients WHERE user_id = auth.uid() AND statut_abonnement = 'ACTIF';
$$;

REVOKE ALL ON FUNCTION prive.mon_client_id() FROM public, anon;
GRANT EXECUTE ON FUNCTION prive.mon_client_id() TO authenticated;

-- ---------------------------------------------------------------------------
-- 5. Fiche client : lisible par son titulaire seulement si l'abonnement est ACTIF
--    (l'application client ne lit pas cette table en direct ; le droit d'accès RGPD d'un client
--    résilié s'exerce par demande au coach, voir docs/politique-confidentialite.md).
-- ---------------------------------------------------------------------------
ALTER POLICY client_lit_sa_fiche ON public.clients
    USING (user_id = (SELECT auth.uid()) AND statut_abonnement = 'ACTIF');

-- ---------------------------------------------------------------------------
-- 6. Journal alimentaire et aliments : LECTURE seule pour le client
--    Anciennes policies FOR ALL : un client pouvait, en appel direct, réécrire consigne_coach /
--    target_kcal de ses blocs, ou insérer des aliments sans les bornes ni le marquage est_estimation
--    de l'API. ALTER POLICY ne peut pas changer la commande (ALL → SELECT) : suppression puis création.
-- ---------------------------------------------------------------------------
DROP POLICY client_gere_ses_repas ON public.journal_repas;
CREATE POLICY client_lit_ses_repas ON public.journal_repas FOR SELECT TO authenticated
    USING (client_id = (SELECT prive.mon_client_id()));

DROP POLICY client_gere_ses_aliments ON public.aliments_scannes;
CREATE POLICY client_lit_ses_aliments ON public.aliments_scannes FOR SELECT TO authenticated
    USING (repas_id IN (SELECT id FROM public.journal_repas WHERE client_id = (SELECT prive.mon_client_id())));

-- ---------------------------------------------------------------------------
-- 7. Séances réalisées : plus d'INSERT direct par le client
--    (l'API refuse une date future ; l'ancienne policy ne contrôlait ni la date ni seance_id).
--    La lecture reste assurée par client_lit_son_historique (SELECT, inchangée).
-- ---------------------------------------------------------------------------
DROP POLICY client_valide_une_seance ON public.seances_realisees;

-- ---------------------------------------------------------------------------
-- 8. Règles de redirection et boutons : réservés aux comptes liés à une fiche ACTIF
--    Avant : un compte authentifié SANS fiche (mon_client_id() NULL) lisait toutes les lignes globales
--    (client_id NULL), liens URL / VIDEO compris.
-- ---------------------------------------------------------------------------
ALTER POLICY client_lit_ses_regles ON public.regles_redirection
    USING (actif
           AND (SELECT prive.mon_client_id()) IS NOT NULL
           AND (client_id IS NULL OR client_id = (SELECT prive.mon_client_id())));
ALTER POLICY client_lit_ses_boutons ON public.boutons_actions
    USING (actif
           AND (SELECT prive.mon_client_id()) IS NOT NULL
           AND (client_id IS NULL OR client_id = (SELECT prive.mon_client_id())));

COMMIT;

-- ---------------------------------------------------------------------------
-- Vérifications après exécution (lecture seule, à lancer séparément)
-- ---------------------------------------------------------------------------
-- Contrainte élargie et nouvelles colonnes (2 lignes attendues) :
--   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--    WHERE conrelid = 'public.clients'::regclass AND conname = 'clients_statut_abonnement_check';
--   SELECT column_name, data_type FROM information_schema.columns
--    WHERE table_schema = 'public' AND table_name = 'clients'
--      AND column_name IN ('formulaire_recu_le', 'statut_modifie_le');
-- Trigger présent et actif (tgenabled = 'O') :
--   SELECT tgname, tgenabled FROM pg_trigger
--    WHERE tgrelid = 'public.clients'::regclass AND NOT tgisinternal;
-- Essai facultatif, sans trace : le bloc se termine par une erreur VOULUE, qui annule l'insertion et affiche
-- la date posée (attendu : l'heure actuelle, pas le 01/01/2000 fourni).
--   DO $$
--   DECLARE d TIMESTAMPTZ;
--   BEGIN
--       INSERT INTO public.clients (email, nom, statut_modifie_le)
--       VALUES ('essai@example.invalid', 'Essai', '2000-01-01') RETURNING statut_modifie_le INTO d;
--       RAISE EXCEPTION 'Essai annulé, rien n''est enregistré. statut_modifie_le posé : %', d;
--   END $$;
-- Plus aucune policy client autre que SELECT (résultat attendu : 0 ligne) :
--   SELECT tablename, policyname, cmd FROM pg_policies
--    WHERE schemaname = 'public' AND policyname LIKE 'client%' AND cmd <> 'SELECT';
-- Fonction filtrée sur ACTIF :
--   SELECT pg_get_functiondef('prive.mon_client_id()'::regprocedure);
-- Security Advisor (Supabase → Advisors) : aucune nouvelle alerte attendue.
