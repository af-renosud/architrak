-- Task #425 — evidence records for the firm's own outbound honoraires
-- invoices caught by Gmail polling. Parked pending_review; the
-- confirmation transaction (milestone invoiced + fee entry) is Task #426.
CREATE TABLE "architect_fee_invoices" (
  "id" serial PRIMARY KEY NOT NULL,
  "email_document_id" integer,
  "intake_document_id" integer,
  "project_id" integer,
  "milestone_id" integer,
  "fee_entry_id" integer,
  "invoice_number" text,
  "invoice_number_normalized" text,
  "issue_date" date,
  "amount_ht" numeric(12, 2),
  "tva_amount" numeric(12, 2),
  "amount_ttc" numeric(12, 2),
  "client_name" text,
  "file_name" text,
  "storage_key" text,
  "source" text DEFAULT 'gmail' NOT NULL,
  "status" text DEFAULT 'pending_review' NOT NULL,
  "identity_reason" text,
  "candidates" jsonb,
  "extraction_snapshot" jsonb,
  "reviewed_by" text,
  "reviewed_at" timestamp with time zone,
  "notes" text,
  "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  CONSTRAINT "architect_fee_invoices_status_chk" CHECK ("status" IN ('pending_review','confirmed','dismissed'))
);
--> statement-breakpoint
ALTER TABLE "architect_fee_invoices" ADD CONSTRAINT "architect_fee_invoices_email_document_id_email_documents_id_fk" FOREIGN KEY ("email_document_id") REFERENCES "public"."email_documents"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "architect_fee_invoices" ADD CONSTRAINT "architect_fee_invoices_intake_document_id_project_intake_documents_id_fk" FOREIGN KEY ("intake_document_id") REFERENCES "public"."project_intake_documents"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "architect_fee_invoices" ADD CONSTRAINT "architect_fee_invoices_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "architect_fee_invoices" ADD CONSTRAINT "architect_fee_invoices_milestone_id_design_contract_milestones_id_fk" FOREIGN KEY ("milestone_id") REFERENCES "public"."design_contract_milestones"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "architect_fee_invoices" ADD CONSTRAINT "architect_fee_invoices_fee_entry_id_fee_entries_id_fk" FOREIGN KEY ("fee_entry_id") REFERENCES "public"."fee_entries"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "architect_fee_invoices_email_doc_unique" ON "architect_fee_invoices" ("email_document_id") WHERE "email_document_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "architect_fee_invoices_intake_doc_unique" ON "architect_fee_invoices" ("intake_document_id") WHERE "intake_document_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "architect_fee_invoices_ref_unique" ON "architect_fee_invoices" ("invoice_number_normalized") WHERE "invoice_number_normalized" IS NOT NULL AND "status" <> 'dismissed';
--> statement-breakpoint
CREATE INDEX "architect_fee_invoices_status_idx" ON "architect_fee_invoices" ("status");
