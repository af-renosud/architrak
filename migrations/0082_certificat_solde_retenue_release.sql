-- Task #464 — solde certificat + explicit retenue de garantie release.
-- marches: réception des travaux date (GPA end = réception + 1 an, derived).
-- certificats: solde flag + release state (released, amount, reason, date).
-- Partial unique index: at most one non-superseded solde certificat per
-- (project, contractor).
ALTER TABLE "marches" ADD COLUMN IF NOT EXISTS "reception_date" date;--> statement-breakpoint
ALTER TABLE "certificats" ADD COLUMN IF NOT EXISTS "is_solde" boolean NOT NULL DEFAULT false;--> statement-breakpoint
ALTER TABLE "certificats" ADD COLUMN IF NOT EXISTS "retenue_released" boolean NOT NULL DEFAULT false;--> statement-breakpoint
ALTER TABLE "certificats" ADD COLUMN IF NOT EXISTS "retenue_release_amount" numeric(12, 2) NOT NULL DEFAULT '0.00';--> statement-breakpoint
ALTER TABLE "certificats" ADD COLUMN IF NOT EXISTS "retenue_release_reason" text;--> statement-breakpoint
ALTER TABLE "certificats" ADD COLUMN IF NOT EXISTS "retenue_release_date" date;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "certificats_solde_unique" ON "certificats" ("project_id","contractor_id") WHERE "is_solde" = true AND "status" <> 'superseded';
