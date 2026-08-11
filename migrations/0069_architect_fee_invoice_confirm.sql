-- Task #426 — confirmation of caught architect fee invoices.
--
-- 1. fee_entries.pennylane_invoice_number: the HUMAN-VISIBLE Pennylane
--    invoice number (e.g. "F-2026-138") captured at push time. The API id
--    alone cannot reconcile an inbound facture d'honoraires PDF.
-- 2. architect_fee_invoice_events: APPEND-ONLY audit of review decisions
--    (confirm / dismiss / conflict parked / replay). Never updated/deleted.

ALTER TABLE "fee_entries" ADD COLUMN IF NOT EXISTS "pennylane_invoice_number" text;

CREATE TABLE IF NOT EXISTS "architect_fee_invoice_events" (
  "id" serial PRIMARY KEY NOT NULL,
  "architect_fee_invoice_id" integer NOT NULL,
  "action" text NOT NULL,
  "actor" text,
  "note" text,
  "details" jsonb,
  "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  CONSTRAINT "architect_fee_invoice_events_action_chk"
    CHECK ("action" IN ('confirmed','dismissed','conflict_parked','replayed'))
);

DO $$ BEGIN
  ALTER TABLE "architect_fee_invoice_events"
    ADD CONSTRAINT "architect_fee_invoice_events_architect_fee_invoice_id_architect_fee_invoices_id_fk"
    FOREIGN KEY ("architect_fee_invoice_id") REFERENCES "architect_fee_invoices"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "architect_fee_invoice_events_invoice_idx"
  ON "architect_fee_invoice_events" ("architect_fee_invoice_id");
