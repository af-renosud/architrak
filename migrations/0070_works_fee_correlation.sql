-- Task #430 — works-commission fee-invoice correlation.
--
-- The firm's commission invoices on contractor works carry the originating
-- DEVIS reference. The AI extraction already reads it (devisNumber), but it
-- was buried in extraction_snapshot JSONB. Promote it to first-class columns
-- so candidate ranking, Pennylane reconciliation and the review UI can use
-- it, and backfill rows captured before this change.
--
-- Normalization mirrors shared/intake-dedup.ts normalizeRef (lowercase,
-- alphanumerics only). Accented characters are simply dropped by the SQL
-- backfill (devis references are ASCII in practice); capture-time writes use
-- the TS normalizer going forward.

ALTER TABLE "architect_fee_invoices" ADD COLUMN IF NOT EXISTS "devis_number" text;
ALTER TABLE "architect_fee_invoices" ADD COLUMN IF NOT EXISTS "devis_number_normalized" text;

UPDATE "architect_fee_invoices"
SET
  "devis_number" = NULLIF(btrim(extraction_snapshot->>'devisNumber'), ''),
  "devis_number_normalized" = NULLIF(lower(regexp_replace(extraction_snapshot->>'devisNumber', '[^a-zA-Z0-9]', '', 'g')), '')
WHERE "devis_number" IS NULL
  AND extraction_snapshot ? 'devisNumber';
