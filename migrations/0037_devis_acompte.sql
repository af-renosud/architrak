-- Task #215 — Acompte / opening-account workflow on devis.
--
-- French BTP devis often demand a 30% deposit ("acompte") payable on
-- order or signature. The contractor issues a SEPARATE facture
-- d'acompte after signing, and every subsequent progress invoice
-- ("situation") must show "déduction acompte versé" so the client is
-- not double-billed for the deposit.
--
-- Eight nullable/defaulted columns on `devis` carry the per-devis
-- acompte spec, the lifecycle state, and the per-devis override of
-- the "block progress invoicing until acompte is paid" gate.
--
-- State machine (acompte_state):
--   none      — no acompte detected/required for this devis (default)
--   pending   — required, awaiting facture d'acompte
--   invoiced  — facture d'acompte received, awaiting payment
--   paid      — facture d'acompte marked paid (auto on invoice.datePaid
--               or via explicit POST /api/devis/:id/acompte/mark-paid)
--   applied   — final reconciliation passed (acompte fully deducted on
--               subsequent invoices ±€0.01) — terminal
--
-- The gate (situation/invoice creation) blocks while state is in
-- {pending, invoiced} unless allow_progress_before_acompte=true on
-- the devis. Default is false (gate ON) per task spec.
--
-- No data backfill — existing devis carry acompte_required=false /
-- acompte_state='none', which is the same default new rows get; the
-- gate is dormant for legacy rows until an architect ticks the
-- "Acompte requis" checkbox in the Edit References modal.

ALTER TABLE devis
  ADD COLUMN IF NOT EXISTS acompte_required boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS acompte_percent numeric(5,2),
  ADD COLUMN IF NOT EXISTS acompte_amount_ht numeric(12,2),
  ADD COLUMN IF NOT EXISTS acompte_trigger text,
  ADD COLUMN IF NOT EXISTS acompte_state text NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS acompte_invoice_id integer REFERENCES invoices(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS acompte_paid_at timestamptz,
  ADD COLUMN IF NOT EXISTS allow_progress_before_acompte boolean NOT NULL DEFAULT false;

-- Helpful for the future ops dashboard query "all devis blocked on
-- unpaid acompte" — partial so the index size stays bounded.
CREATE INDEX IF NOT EXISTS devis_acompte_pending_idx
  ON devis (acompte_state)
  WHERE acompte_required = true AND acompte_state IN ('pending', 'invoiced');
