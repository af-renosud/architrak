-- Task #649 — explicit, audited devis closure after works reception.
-- Existing devis remain open. Only the dedicated server transition may stamp
-- the closed state; DB checks prevent partial or unaudited closure records.
ALTER TABLE "devis" ADD COLUMN IF NOT EXISTS "closure_state" text DEFAULT 'open' NOT NULL;--> statement-breakpoint
ALTER TABLE "devis" ADD COLUMN IF NOT EXISTS "closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "devis" ADD COLUMN IF NOT EXISTS "closed_by_user_id" integer;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "devis" ADD CONSTRAINT "devis_closed_by_user_id_users_id_fk" FOREIGN KEY ("closed_by_user_id") REFERENCES "users"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "devis" ADD CONSTRAINT "devis_closure_state_chk" CHECK ("closure_state" IN ('open', 'closed'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "devis" ADD CONSTRAINT "devis_closure_audit_chk" CHECK (
    ("closure_state" = 'open' AND "closed_at" IS NULL AND "closed_by_user_id" IS NULL)
    OR
    ("closure_state" = 'closed' AND "closed_at" IS NOT NULL AND "closed_by_user_id" IS NOT NULL)
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;