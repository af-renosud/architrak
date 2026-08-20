-- Task #649 review hardening — retain immutable provenance for the exact
-- marché/PV relationship that satisfied the legal closure gate.
ALTER TABLE "devis" ADD COLUMN IF NOT EXISTS "closure_marche_id" integer;--> statement-breakpoint
ALTER TABLE "devis" ADD COLUMN IF NOT EXISTS "closure_project_id" integer;--> statement-breakpoint
ALTER TABLE "devis" ADD COLUMN IF NOT EXISTS "closure_contractor_id" integer;--> statement-breakpoint
ALTER TABLE "devis" ADD COLUMN IF NOT EXISTS "closure_reception_date" date;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "devis" ADD CONSTRAINT "devis_closure_marche_id_marches_id_fk" FOREIGN KEY ("closure_marche_id") REFERENCES "marches"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "devis" ADD CONSTRAINT "devis_closure_project_id_projects_id_fk" FOREIGN KEY ("closure_project_id") REFERENCES "projects"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "devis" ADD CONSTRAINT "devis_closure_contractor_id_contractors_id_fk" FOREIGN KEY ("closure_contractor_id") REFERENCES "contractors"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
ALTER TABLE "devis" DROP CONSTRAINT IF EXISTS "devis_closure_audit_chk";--> statement-breakpoint
ALTER TABLE "devis" ADD CONSTRAINT "devis_closure_audit_chk" CHECK (
  (
    "closure_state" = 'open'
    AND "closed_at" IS NULL
    AND "closed_by_user_id" IS NULL
    AND "closure_marche_id" IS NULL
    AND "closure_project_id" IS NULL
    AND "closure_contractor_id" IS NULL
    AND "closure_reception_date" IS NULL
  )
  OR
  (
    "closure_state" = 'closed'
    AND "closed_at" IS NOT NULL
    AND "closed_by_user_id" IS NOT NULL
    AND "closure_marche_id" IS NOT NULL
    AND "closure_project_id" IS NOT NULL
    AND "closure_contractor_id" IS NOT NULL
    AND "closure_reception_date" IS NOT NULL
  )
);