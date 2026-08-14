-- Task #462 — Acompte recoupment (remboursement d'acompte).
-- The deposit paid on a devis must be recovered on certificats or the
-- contractor is paid twice. Rule config lives on the marché; each certificat
-- persists the cumulative + period recoupment amounts (server-derived only).

ALTER TABLE "marches"
  ADD COLUMN "acompte_recoupment_rule" text NOT NULL DEFAULT 'asap',
  ADD COLUMN "acompte_recoupment_percent" numeric(5, 2),
  ADD COLUMN "acompte_recoupment_threshold_percent" numeric(5, 2);

ALTER TABLE "certificats"
  ADD COLUMN "cumulative_acompte_recoupment" numeric(12, 2) NOT NULL DEFAULT '0.00',
  ADD COLUMN "period_acompte_recoupment" numeric(12, 2) NOT NULL DEFAULT '0.00';
