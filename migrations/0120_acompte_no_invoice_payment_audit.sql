-- Task #686 — immutable audit/provenance for a supplier opening deposit paid
-- without a supplier invoice. The unique devis mapping is the replay guard.
CREATE TABLE IF NOT EXISTS "acompte_no_invoice_payments" (
  "id" serial PRIMARY KEY NOT NULL,
  "devis_id" integer NOT NULL,
  "certificat_id" integer NOT NULL,
  "source_intake_document_id" integer NOT NULL,
  "source_storage_key" text NOT NULL,
  "source_file_name" text NOT NULL,
  "source_content_fingerprint" text NOT NULL,
  "amount_ht" numeric(12, 2) NOT NULL,
  "amount_ttc" numeric(12, 2) NOT NULL,
  "paid_at" timestamp with time zone NOT NULL,
  "payment_reference" text NOT NULL,
  "evidence_text" text,
  "confirmed_by_user_id" integer NOT NULL,
  "confirmed_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
  CONSTRAINT "acompte_no_invoice_payments_devis_fk" FOREIGN KEY ("devis_id") REFERENCES "devis"("id") ON DELETE RESTRICT,
  CONSTRAINT "acompte_no_invoice_payments_certificat_fk" FOREIGN KEY ("certificat_id") REFERENCES "certificats"("id") ON DELETE RESTRICT,
  CONSTRAINT "acompte_no_invoice_payments_source_intake_document_fk" FOREIGN KEY ("source_intake_document_id") REFERENCES "project_intake_documents"("id") ON DELETE RESTRICT,
  CONSTRAINT "acompte_no_invoice_payments_confirmed_by_user_fk" FOREIGN KEY ("confirmed_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT,
  CONSTRAINT "acompte_no_invoice_payments_amounts_nonnegative" CHECK ("amount_ht" > 0 AND "amount_ttc" > 0)
);--> statement-breakpoint
ALTER TABLE "acompte_no_invoice_payments" ADD COLUMN IF NOT EXISTS "source_storage_key" text;--> statement-breakpoint
ALTER TABLE "acompte_no_invoice_payments" ADD COLUMN IF NOT EXISTS "source_file_name" text;--> statement-breakpoint
ALTER TABLE "acompte_no_invoice_payments" ADD COLUMN IF NOT EXISTS "source_content_fingerprint" text;--> statement-breakpoint
UPDATE "acompte_no_invoice_payments" p
SET "source_storage_key" = d."storage_key",
    "source_file_name" = d."file_name",
    "source_content_fingerprint" = d."content_fingerprint"
FROM "project_intake_documents" d
WHERE d."id" = p."source_intake_document_id"
  AND (p."source_storage_key" IS NULL OR p."source_file_name" IS NULL OR p."source_content_fingerprint" IS NULL);--> statement-breakpoint
ALTER TABLE "acompte_no_invoice_payments"
  ALTER COLUMN "source_storage_key" SET NOT NULL,
  ALTER COLUMN "source_file_name" SET NOT NULL,
  ALTER COLUMN "source_content_fingerprint" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "acompte_no_invoice_payments_devis_unique" ON "acompte_no_invoice_payments" ("devis_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "acompte_no_invoice_payments_certificat_unique" ON "acompte_no_invoice_payments" ("certificat_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "acompte_no_invoice_payments_source_intake_document_id_idx" ON "acompte_no_invoice_payments" ("source_intake_document_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "acompte_no_invoice_payments_confirmed_by_user_id_idx" ON "acompte_no_invoice_payments" ("confirmed_by_user_id");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION prevent_acompte_no_invoice_payment_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('app.allow_acompte_audit_delete', true) = 'true' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'acompte_no_invoice_payments rows are immutable';
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS acompte_no_invoice_payments_immutable_trg ON acompte_no_invoice_payments;
--> statement-breakpoint
CREATE TRIGGER acompte_no_invoice_payments_immutable_trg
BEFORE UPDATE OR DELETE ON acompte_no_invoice_payments
FOR EACH ROW EXECUTE FUNCTION prevent_acompte_no_invoice_payment_mutation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION reject_archived_project_financial_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM projects WHERE id = NEW.project_id AND archived_at IS NOT NULL) THEN
    RAISE EXCEPTION 'archived projects are read-only' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS invoices_reject_archived_project_insert_trg ON invoices;
--> statement-breakpoint
CREATE TRIGGER invoices_reject_archived_project_insert_trg
BEFORE INSERT ON invoices FOR EACH ROW EXECUTE FUNCTION reject_archived_project_financial_insert();
--> statement-breakpoint
DROP TRIGGER IF EXISTS devis_reject_archived_project_insert_trg ON devis;
--> statement-breakpoint
CREATE TRIGGER devis_reject_archived_project_insert_trg
BEFORE INSERT ON devis FOR EACH ROW EXECUTE FUNCTION reject_archived_project_financial_insert();