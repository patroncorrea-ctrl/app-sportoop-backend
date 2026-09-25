-- Vérifications en LECTURE SEULE à lancer avant 20260925_schema_v2.sql.
-- Une seule requête (l'éditeur Supabase n'affiche que le résultat du dernier SELECT).
-- Toutes les lignes doivent afficher problemes = 0 ; sinon, corriger les données avant la migration.

SELECT '1. doublons repas' AS controle, count(*) AS problemes
FROM (SELECT 1 FROM public.journal_repas
      GROUP BY client_id, date_repas, type_repas HAVING count(*) > 1) d
UNION ALL
SELECT '2. type_repas invalide', count(*) FROM public.journal_repas
WHERE type_repas NOT IN ('PETIT_DEJEUNER','COLLATION_MATIN','DEJEUNER','COLLATION_APRES_MIDI',
                         'DINER','PRE_WORKOUT','WORKOUT','POST_WORKOUT')
UNION ALL
SELECT '3. statut seance invalide', count(*) FROM public.seances
WHERE statut IS NULL OR statut NOT IN ('A_FAIRE','FAIT','MANQUE')
UNION ALL
SELECT '4. jour_semaine invalide', count(*) FROM public.seances
WHERE jour_semaine NOT IN ('Lundi','Mardi','Mercredi','Jeudi','Vendredi','Samedi','Dimanche')
UNION ALL
SELECT '5. methode_ajout invalide', count(*) FROM public.aliments_scannes
WHERE methode_ajout IS NULL OR methode_ajout NOT IN ('scan_barcode','photo_ia','manuel');
