ALTER TABLE "devis_translations" ADD COLUMN IF NOT EXISTS "approved_at" timestamp;--> statement-breakpoint
ALTER TABLE "devis_translations" ADD COLUMN IF NOT EXISTS "approved_by" integer;--> statement-breakpoint
ALTER TABLE "devis_translations" ADD COLUMN IF NOT EXISTS "approved_by_email" text;
