-- A single design invoice may cover several milestone payments. Preserve
-- normalized-reference dedup for caught (non-manual) invoice evidence, while
-- allowing each manually recorded milestone to keep its own evidence and fee
-- entry under the shared invoice number.
DROP INDEX IF EXISTS "architect_fee_invoices_ref_unique";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "architect_fee_invoices_captured_ref_unique"
  ON "architect_fee_invoices" ("invoice_number_normalized")
  WHERE "invoice_number_normalized" IS NOT NULL
    AND "status" <> 'dismissed'
    AND "source" <> 'manual';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "architect_fee_invoices_ref_idx"
  ON "architect_fee_invoices" ("invoice_number_normalized")
  WHERE "invoice_number_normalized" IS NOT NULL
    AND "status" <> 'dismissed';