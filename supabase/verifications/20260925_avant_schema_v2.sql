-- Vérifications en LECTURE SEULE à lancer avant 20260925_schema_v2.sql.
-- Chaque requête doit renvoyer 0 ligne ; sinon, corriger les données avant la migration.

-- 1. Doublons (client_id, date_repas, type_repas) qui bloqueraient la contrainte d'unicité
SELECT client_id, date_repas, type_repas, count(*)
FROM public.journal_repas
GROUP BY 1, 2, 3
HAVING count(*) > 1;

-- 2. Valeurs de type_repas hors des 8 blocs
SELECT DISTINCT type_repas FROM public.journal_repas
WHERE type_repas NOT IN ('PETIT_DEJEUNER','COLLATION_MATIN','DEJEUNER','COLLATION_APRES_MIDI',
                         'DINER','PRE_WORKOUT','WORKOUT','POST_WORKOUT');

-- 3. Valeurs de statut de séance inattendues
SELECT DISTINCT statut FROM public.seances
WHERE statut NOT IN ('A_FAIRE','FAIT','MANQUE');

-- 4. Jours de semaine inattendus
SELECT DISTINCT jour_semaine FROM public.seances
WHERE jour_semaine NOT IN ('Lundi','Mardi','Mercredi','Jeudi','Vendredi','Samedi','Dimanche');

-- 5. Méthodes d'ajout inattendues
SELECT DISTINCT methode_ajout FROM public.aliments_scannes
WHERE methode_ajout NOT IN ('scan_barcode','photo_ia','manuel');
