-- Task #566 — PV de réception gate for final payment.
-- marches: PV de réception record (draft → approved) with document OR
-- attestation, approver audit; reception date stays in reception_date.
-- certificats: audited override of the PV gate (reason + who + when).
ALTER TABLE "marches" ADD COLUMN IF NOT EXISTS "pv_reception_status" text;--> statement-breakpoint
ALTER TABLE "marches" ADD COLUMN IF NOT EXISTS "pv_document_storage_key" text;--> statement-breakpoint
ALTER TABLE "marches" ADD COLUMN IF NOT EXISTS "pv_document_file_name" text;--> statement-breakpoint
ALTER TABLE "marches" ADD COLUMN IF NOT EXISTS "pv_attestation_note" text;--> statement-breakpoint
ALTER TABLE "marches" ADD COLUMN IF NOT EXISTS "pv_approved_by_user_id" integer;--> statement-breakpoint
ALTER TABLE "marches" ADD COLUMN IF NOT EXISTS "pv_approved_at" timestamp;--> statement-breakpoint
ALTER TABLE "certificats" ADD COLUMN IF NOT EXISTS "pv_override_reason" text;--> statement-breakpoint
ALTER TABLE "certificats" ADD COLUMN IF NOT EXISTS "pv_override_by_user_id" integer;--> statement-breakpoint
ALTER TABLE "certificats" ADD COLUMN IF NOT EXISTS "pv_override_at" timestamp;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "marches" ADD CONSTRAINT "marches_pv_approved_by_user_id_users_id_fk" FOREIGN KEY ("pv_approved_by_user_id") REFERENCES "users"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "certificats" ADD CONSTRAINT "certificats_pv_override_by_user_id_users_id_fk" FOREIGN KEY ("pv_override_by_user_id") REFERENCES "users"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
