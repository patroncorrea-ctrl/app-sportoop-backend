-- Durcissement après le schéma v2 (retours du Security/Performance Advisor Supabase)
-- 1. Les fonctions d'aide RLS passent dans un schéma privé, non exposé par l'API REST
--    (lint 0029 : SECURITY DEFINER appelable via /rest/v1/rpc).
-- 2. Index sur les clés étrangères non couvertes (lint 0001).
-- Aucune donnée touchée : seules les 2 anciennes fonctions public.* sont supprimées,
-- après que toutes les policies ont été repointées vers les nouvelles.

BEGIN;

CREATE SCHEMA IF NOT EXISTS prive;
REVOKE ALL ON SCHEMA prive FROM public, anon;
GRANT USAGE ON SCHEMA prive TO authenticated;

CREATE OR REPLACE FUNCTION prive.est_coach() RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT EXISTS (SELECT 1 FROM public.coachs WHERE user_id = auth.uid());
$$;

CREATE OR REPLACE FUNCTION prive.mon_client_id() RETURNS UUID
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT id FROM public.clients WHERE user_id = auth.uid();
$$;

REVOKE ALL ON FUNCTION prive.est_coach(), prive.mon_client_id() FROM public, anon;
GRANT EXECUTE ON FUNCTION prive.est_coach(), prive.mon_client_id() TO authenticated;

-- Policies repointées. (SELECT ...) permet à Postgres d'évaluer la fonction une seule fois par requête.
ALTER POLICY coach_tout ON public.clients            USING ((SELECT prive.est_coach())) WITH CHECK ((SELECT prive.est_coach()));
ALTER POLICY coach_tout ON public.seances            USING ((SELECT prive.est_coach())) WITH CHECK ((SELECT prive.est_coach()));
ALTER POLICY coach_tout ON public.journal_repas      USING ((SELECT prive.est_coach())) WITH CHECK ((SELECT prive.est_coach()));
ALTER POLICY coach_tout ON public.aliments_scannes   USING ((SELECT prive.est_coach())) WITH CHECK ((SELECT prive.est_coach()));
ALTER POLICY coach_tout ON public.seances_realisees  USING ((SELECT prive.est_coach())) WITH CHECK ((SELECT prive.est_coach()));
ALTER POLICY coach_tout ON public.regles_redirection USING ((SELECT prive.est_coach())) WITH CHECK ((SELECT prive.est_coach()));
ALTER POLICY coach_tout ON public.boutons_actions    USING ((SELECT prive.est_coach())) WITH CHECK ((SELECT prive.est_coach()));

ALTER POLICY client_lit_ses_seances ON public.seances
    USING (client_id = (SELECT prive.mon_client_id()));
ALTER POLICY client_gere_ses_repas ON public.journal_repas
    USING (client_id = (SELECT prive.mon_client_id()))
    WITH CHECK (client_id = (SELECT prive.mon_client_id()));
ALTER POLICY client_gere_ses_aliments ON public.aliments_scannes
    USING (repas_id IN (SELECT id FROM public.journal_repas WHERE client_id = (SELECT prive.mon_client_id())))
    WITH CHECK (repas_id IN (SELECT id FROM public.journal_repas WHERE client_id = (SELECT prive.mon_client_id())));
ALTER POLICY client_lit_son_historique ON public.seances_realisees
    USING (client_id = (SELECT prive.mon_client_id()));
ALTER POLICY client_valide_une_seance ON public.seances_realisees
    WITH CHECK (client_id = (SELECT prive.mon_client_id()));
ALTER POLICY client_lit_ses_regles ON public.regles_redirection
    USING (actif AND (client_id IS NULL OR client_id = (SELECT prive.mon_client_id())));
ALTER POLICY client_lit_ses_boutons ON public.boutons_actions
    USING (actif AND (client_id IS NULL OR client_id = (SELECT prive.mon_client_id())));

-- Plus aucune policy ne les utilise : suppression des versions exposées.
DROP FUNCTION public.est_coach();
DROP FUNCTION public.mon_client_id();

CREATE INDEX IF NOT EXISTS boutons_actions_client_id_idx    ON public.boutons_actions (client_id);
CREATE INDEX IF NOT EXISTS regles_redirection_client_id_idx ON public.regles_redirection (client_id);
CREATE INDEX IF NOT EXISTS regles_redirection_seance_id_idx ON public.regles_redirection (seance_id);

COMMIT;
