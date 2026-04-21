ALTER TABLE "devis_translations" ADD COLUMN "approved_at" timestamp;--> statement-breakpoint
ALTER TABLE "devis_translations" ADD COLUMN "approved_by" integer;--> statement-breakpoint
ALTER TABLE "devis_translations" ADD COLUMN "approved_by_email" text;