-- Task #243 — Compte Prorata levy + hard-wired Retenue de Garantie bypass.
--
-- Adds:
--   projects.prorata_percentage          — project-wide Compte Prorata levy rate
--   marches.has_bank_guarantee           — bypass the cash Retenue de Garantie
--   marches.is_prorata_manager           — this marché collects prorata (exempt)
--   certificats.cumulative_prorata_deduction / period_prorata_deduction
--
-- All additive with safe defaults so existing rows are unchanged: prorata rate
-- 0.00 (no levy), no bank guarantee, not a prorata manager, zero prorata
-- deductions on historical certificats. DDL is idempotent (IF NOT EXISTS) so
-- partial-apply recovery is safe.

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS prorata_percentage numeric(5, 2) NOT NULL DEFAULT '0.00';

ALTER TABLE marches
  ADD COLUMN IF NOT EXISTS has_bank_guarantee boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_prorata_manager boolean NOT NULL DEFAULT false;

ALTER TABLE certificats
  ADD COLUMN IF NOT EXISTS cumulative_prorata_deduction numeric(12, 2) NOT NULL DEFAULT '0.00',
  ADD COLUMN IF NOT EXISTS period_prorata_deduction numeric(12, 2) NOT NULL DEFAULT '0.00';
