-- Suivi de l'abonnement Systeme.io (achat / résiliation) — migration ADDITIVE, aucune donnée supprimée.

BEGIN;

ALTER TABLE public.clients
    ADD COLUMN statut_abonnement TEXT NOT NULL DEFAULT 'ACTIF'
        CHECK (statut_abonnement IN ('ACTIF','RESILIE')),
    ADD COLUMN abonnement_maj_le TIMESTAMPTZ,
    ADD COLUMN systemeio_contact_id BIGINT;

CREATE INDEX IF NOT EXISTS clients_systemeio_contact_id_idx ON public.clients (systemeio_contact_id);

COMMIT;
