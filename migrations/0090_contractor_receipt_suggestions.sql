-- Task #519 — contractor payment-notice emails + receipt suggestions.
--
-- A second email now goes to the CONTRACTOR when a certificat is sent to
-- the client (project_communications.type = 'certificat_contractor_notice';
-- no schema change needed there — the type column is an open vocabulary).
-- Replies on that thread become suggestions in the SAME review table,
-- distinguished by `kind`:
--   'client_paid'          — the client says they paid (existing behaviour)
--   'contractor_received'  — the contractor confirms the money arrived
--
-- The pending-uniqueness rule becomes per (certificat, kind): a client
-- "paid" suggestion must not block the contractor's "received" one (and
-- vice-versa), but duplicates of the SAME kind still never stack.
ALTER TABLE "certificat_payment_suggestions"
  ADD COLUMN "kind" text NOT NULL DEFAULT 'client_paid';

ALTER TABLE "certificat_payment_suggestions"
  ADD CONSTRAINT "certificat_payment_suggestions_kind_check"
  CHECK ("kind" IN ('client_paid', 'contractor_received'));

DROP INDEX IF EXISTS "certificat_payment_suggestions_pending_unique";
CREATE UNIQUE INDEX "certificat_payment_suggestions_pending_unique"
  ON "certificat_payment_suggestions" ("certificat_id", "kind")
  WHERE "status" = 'pending_review';
