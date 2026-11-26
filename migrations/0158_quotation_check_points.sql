CREATE TABLE IF NOT EXISTS "quotation_check_reviews" (
"id" serial PRIMARY KEY NOT NULL,
"devis_id" integer NOT NULL,
"point_key" text NOT NULL,
"action" text NOT NULL,
"reason" text,
"worksheet_id" integer,
"point" jsonb NOT NULL,
"actor_user_id" integer,
"created_at" timestamp with time zone DEFAULT now() NOT NULL,
CONSTRAINT "quotation_check_reviews_action_check" CHECK ("quotation_check_reviews"."action" IN ('dismissed','reopened','added_to_worksheet'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "quotation_check_ai_runs" (
"id" serial PRIMARY KEY NOT NULL,
"devis_id" integer NOT NULL,
"status" text NOT NULL,
"lines_fingerprint" text NOT NULL,
"model_id" text,
"points" jsonb,
"error" text,
"actor_user_id" integer,
"created_at" timestamp with time zone DEFAULT now() NOT NULL,
CONSTRAINT "quotation_check_ai_runs_status_check" CHECK ("quotation_check_ai_runs"."status" IN ('succeeded','failed'))
);
--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "quotation_check_ai_runs" ADD CONSTRAINT "quotation_check_ai_runs_devis_id_devis_id_fk" FOREIGN KEY ("devis_id") REFERENCES "public"."devis"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "quotation_check_reviews_devis_idx" ON "quotation_check_reviews" USING btree ("devis_id","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "quotation_check_ai_runs_devis_idx" ON "quotation_check_ai_runs" USING btree ("devis_id","id");--> statement-breakpoint
CREATE OR REPLACE FUNCTION quotation_check_reviews_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'quotation_check_reviews rows are append-only and cannot be % ', TG_OP
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "quotation_check_reviews_immutable" ON "quotation_check_reviews";
--> statement-breakpoint
CREATE TRIGGER "quotation_check_reviews_immutable" BEFORE UPDATE OR DELETE ON "quotation_check_reviews"
  FOR EACH ROW EXECUTE FUNCTION quotation_check_reviews_immutable();
