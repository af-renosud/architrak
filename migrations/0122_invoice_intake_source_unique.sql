-- Task #688 review hardening — intake routing is idempotent in the database,
-- not only through the process-local queue/project locks.
ALTER TABLE "invoices"
  ADD COLUMN IF NOT EXISTS "source_intake_document_id" integer;--> statement-breakpoint
ALTER TABLE "invoices"
  DROP CONSTRAINT IF EXISTS "invoices_source_intake_document_fk";--> statement-breakpoint
ALTER TABLE "invoices"
  ADD CONSTRAINT "invoices_source_intake_document_fk"
  FOREIGN KEY ("source_intake_document_id")
  REFERENCES "project_intake_documents"("id")
  ON DELETE RESTRICT;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "invoices_source_intake_document_id_unique"
  ON "invoices" ("source_intake_document_id")
  WHERE "source_intake_document_id" IS NOT NULL;