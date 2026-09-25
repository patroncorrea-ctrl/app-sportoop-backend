-- Schéma v2 — ADRM SPORTOOP
-- Migration ADDITIVE : aucune colonne ni table supprimée, aucune donnée effacée.
-- Prérequis : supabase/verifications/20260925_avant_schema_v2.sql renvoie 0 ligne partout.
-- Tout est dans une transaction : en cas d'erreur, rien n'est appliqué.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Valeurs contrôlées (contraintes CHECK)
-- ---------------------------------------------------------------------------
ALTER TABLE public.journal_repas
    ADD CONSTRAINT journal_repas_type_repas_check CHECK (type_repas IN (
        'PETIT_DEJEUNER','COLLATION_MATIN','DEJEUNER','COLLATION_APRES_MIDI',
        'DINER','PRE_WORKOUT','WORKOUT','POST_WORKOUT'));

ALTER TABLE public.seances
    ADD CONSTRAINT seances_statut_check CHECK (statut IN ('A_FAIRE','FAIT','MANQUE')),
    ADD CONSTRAINT seances_jour_semaine_check CHECK (jour_semaine IN (
        'Lundi','Mardi','Mercredi','Jeudi','Vendredi','Samedi','Dimanche'));

ALTER TABLE public.aliments_scannes
    ADD CONSTRAINT aliments_scannes_methode_ajout_check
        CHECK (methode_ajout IN ('scan_barcode','photo_ia','manuel')),
    ADD CONSTRAINT aliments_scannes_valeurs_positives_check
        CHECK (kcal >= 0 AND glucides >= 0 AND proteines >= 0 AND lipides >= 0);

-- ---------------------------------------------------------------------------
-- 2. Unicité d'un bloc repas par client et par jour
-- ---------------------------------------------------------------------------
ALTER TABLE public.journal_repas
    ADD CONSTRAINT journal_repas_client_date_type_key UNIQUE (client_id, date_repas, type_repas);

-- ---------------------------------------------------------------------------
-- 3. Aliments : quantité, code-barres, estimation IA
-- ---------------------------------------------------------------------------
ALTER TABLE public.aliments_scannes
    ADD COLUMN quantite_g NUMERIC(7,1) CHECK (quantite_g IS NULL OR quantite_g > 0),
    ADD COLUMN code_barres TEXT,
    ADD COLUMN est_estimation BOOLEAN NOT NULL DEFAULT false; -- true = valeur Gemini à faire corriger

CREATE INDEX IF NOT EXISTS aliments_scannes_repas_id_idx ON public.aliments_scannes (repas_id);
CREATE INDEX IF NOT EXISTS journal_repas_client_date_idx ON public.journal_repas (client_id, date_repas);
CREATE INDEX IF NOT EXISTS seances_client_id_idx ON public.seances (client_id);

-- ---------------------------------------------------------------------------
-- 4. Liaison avec Supabase Auth + consentement RGPD
-- ---------------------------------------------------------------------------
ALTER TABLE public.clients
    ADD COLUMN user_id UUID UNIQUE REFERENCES auth.users(id) ON DELETE SET NULL,
    ADD COLUMN consentement_sante_le TIMESTAMPTZ; -- date du consentement explicite (art. 9 RGPD)

CREATE TABLE public.coachs (
    user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    nom TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT timezone('utc', now()) NOT NULL
);

-- ---------------------------------------------------------------------------
-- 5. Historique daté des séances réalisées
-- ---------------------------------------------------------------------------
CREATE TABLE public.seances_realisees (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
    seance_id UUID REFERENCES public.seances(id) ON DELETE SET NULL, -- garde l'historique si la séance est supprimée
    titre TEXT NOT NULL,                                             -- copie du titre au moment de la réalisation
    date_realisee DATE NOT NULL DEFAULT CURRENT_DATE,
    statut TEXT NOT NULL DEFAULT 'FAIT' CHECK (statut IN ('FAIT','MANQUE')),
    ressenti SMALLINT CHECK (ressenti BETWEEN 1 AND 5),
    commentaire TEXT,
    created_at TIMESTAMPTZ DEFAULT timezone('utc', now()) NOT NULL,
    UNIQUE (seance_id, date_realisee)
);
CREATE INDEX seances_realisees_client_date_idx ON public.seances_realisees (client_id, date_realisee);

-- ---------------------------------------------------------------------------
-- 6. Règles de redirection et boutons dynamiques pilotés par le coach
--    client_id NULL = règle / bouton global, valable pour tous les clients.
-- ---------------------------------------------------------------------------
CREATE TABLE public.regles_redirection (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID REFERENCES public.clients(id) ON DELETE CASCADE,
    declencheur TEXT NOT NULL CHECK (declencheur IN ('SEANCE_VALIDEE','SEANCE_MANQUEE','REPAS_VALIDE')),
    seance_id UUID REFERENCES public.seances(id) ON DELETE CASCADE, -- NULL = toutes les séances
    cible_type TEXT NOT NULL CHECK (cible_type IN ('ECRAN','URL','VIDEO')),
    cible TEXT NOT NULL,
    priorite INT NOT NULL DEFAULT 1,
    actif BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT timezone('utc', now()) NOT NULL
);

CREATE TABLE public.boutons_actions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID REFERENCES public.clients(id) ON DELETE CASCADE,
    emplacement TEXT NOT NULL,  -- ex. 'ACCUEIL', 'SEANCE', 'NUTRITION'
    libelle TEXT NOT NULL,
    action_type TEXT NOT NULL CHECK (action_type IN ('ECRAN','URL','VIDEO')),
    cible TEXT NOT NULL,
    ordre INT NOT NULL DEFAULT 1,
    actif BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT timezone('utc', now()) NOT NULL
);

-- ---------------------------------------------------------------------------
-- 7. Fonctions d'aide pour les policies (SECURITY DEFINER pour éviter la récursion RLS)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.est_coach() RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT EXISTS (SELECT 1 FROM public.coachs WHERE user_id = auth.uid());
$$;

CREATE OR REPLACE FUNCTION public.mon_client_id() RETURNS UUID
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT id FROM public.clients WHERE user_id = auth.uid();
$$;

REVOKE ALL ON FUNCTION public.est_coach(), public.mon_client_id() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.est_coach(), public.mon_client_id() TO authenticated;

-- ---------------------------------------------------------------------------
-- 8. Row Level Security
--    Le backend (clé service_role) contourne la RLS : l'API FastAPI n'est pas impactée.
--    Le rôle anon n'a accès à rien.
-- ---------------------------------------------------------------------------
ALTER TABLE public.clients            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.seances            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.journal_repas      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.aliments_scannes   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.coachs             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.seances_realisees  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.regles_redirection ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.boutons_actions    ENABLE ROW LEVEL SECURITY;

-- Coach : accès complet à toutes les tables métier
CREATE POLICY coach_tout ON public.clients            FOR ALL TO authenticated USING (public.est_coach()) WITH CHECK (public.est_coach());
CREATE POLICY coach_tout ON public.seances            FOR ALL TO authenticated USING (public.est_coach()) WITH CHECK (public.est_coach());
CREATE POLICY coach_tout ON public.journal_repas      FOR ALL TO authenticated USING (public.est_coach()) WITH CHECK (public.est_coach());
CREATE POLICY coach_tout ON public.aliments_scannes   FOR ALL TO authenticated USING (public.est_coach()) WITH CHECK (public.est_coach());
CREATE POLICY coach_tout ON public.seances_realisees  FOR ALL TO authenticated USING (public.est_coach()) WITH CHECK (public.est_coach());
CREATE POLICY coach_tout ON public.regles_redirection FOR ALL TO authenticated USING (public.est_coach()) WITH CHECK (public.est_coach());
CREATE POLICY coach_tout ON public.boutons_actions    FOR ALL TO authenticated USING (public.est_coach()) WITH CHECK (public.est_coach());
CREATE POLICY coach_soi  ON public.coachs             FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));

-- Client : lecture de sa fiche (objectifs modifiés uniquement par le coach ou l'API)
CREATE POLICY client_lit_sa_fiche ON public.clients FOR SELECT TO authenticated
    USING (user_id = (SELECT auth.uid()));

-- Client : lecture de son programme (modifiable à distance par le coach uniquement)
CREATE POLICY client_lit_ses_seances ON public.seances FOR SELECT TO authenticated
    USING (client_id = public.mon_client_id());

-- Client : gestion complète de son journal alimentaire
CREATE POLICY client_gere_ses_repas ON public.journal_repas FOR ALL TO authenticated
    USING (client_id = public.mon_client_id())
    WITH CHECK (client_id = public.mon_client_id());

CREATE POLICY client_gere_ses_aliments ON public.aliments_scannes FOR ALL TO authenticated
    USING (repas_id IN (SELECT id FROM public.journal_repas WHERE client_id = public.mon_client_id()))
    WITH CHECK (repas_id IN (SELECT id FROM public.journal_repas WHERE client_id = public.mon_client_id()));

-- Client : lecture et validation de ses séances réalisées
CREATE POLICY client_lit_son_historique ON public.seances_realisees FOR SELECT TO authenticated
    USING (client_id = public.mon_client_id());
CREATE POLICY client_valide_une_seance ON public.seances_realisees FOR INSERT TO authenticated
    WITH CHECK (client_id = public.mon_client_id());

-- Client : lecture des règles et boutons globaux ou qui lui sont destinés
CREATE POLICY client_lit_ses_regles ON public.regles_redirection FOR SELECT TO authenticated
    USING (actif AND (client_id IS NULL OR client_id = public.mon_client_id()));
CREATE POLICY client_lit_ses_boutons ON public.boutons_actions FOR SELECT TO authenticated
    USING (actif AND (client_id IS NULL OR client_id = public.mon_client_id()));

COMMIT;
