CREATE TABLE IF NOT EXISTS "quotation_worksheet_audit" (
	"id" serial PRIMARY KEY NOT NULL,
	"worksheet_id" integer NOT NULL,
	"devis_id" integer NOT NULL,
	"line_id" integer,
	"actor_user_id" integer,
	"action" text NOT NULL,
	"reason" text,
	"before" jsonb,
	"after" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quotation_worksheet_audit_action_check" CHECK ("quotation_worksheet_audit"."action" IN ('create','duplicate','update_line','add_line','remove_line','restore_line','delete_line','update_settings'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "quotation_worksheet_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"worksheet_id" integer NOT NULL,
	"source_line_item_id" integer,
	"position" integer NOT NULL,
	"section" text DEFAULT 'lot' NOT NULL,
	"lot_label" text NOT NULL,
	"description" text NOT NULL,
	"unit" text,
	"original_quantity" numeric(12, 3),
	"original_unit_price" numeric(12, 2),
	"original_total" numeric(12, 2),
	"vat_rate" numeric(6, 3),
	"client_quantity" numeric(12, 3),
	"client_unit_price" numeric(12, 2),
	"note" text,
	"tag" text,
	CONSTRAINT "quotation_worksheet_lines_section_check" CHECK ("quotation_worksheet_lines"."section" IN ('lot','meeting')),
	CONSTRAINT "quotation_worksheet_lines_tag_check" CHECK ("quotation_worksheet_lines"."tag" IS NULL OR "quotation_worksheet_lines"."tag" IN ('cost_saving','value_added','query_contractor')),
	CONSTRAINT "quotation_worksheet_lines_vat_check" CHECK ("quotation_worksheet_lines"."vat_rate" IS NULL OR ("quotation_worksheet_lines"."vat_rate" >= 0 AND "quotation_worksheet_lines"."vat_rate" <= 100))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "quotation_worksheets" (
	"id" serial PRIMARY KEY NOT NULL,
	"devis_id" integer NOT NULL,
	"project_id" integer NOT NULL,
	"title" text NOT NULL,
	"meeting_date" date,
	"deposit_percent" numeric(5, 2),
	"duplicated_from_id" integer,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quotation_worksheets_deposit_check" CHECK ("quotation_worksheets"."deposit_percent" IS NULL OR ("quotation_worksheets"."deposit_percent" >= 0 AND "quotation_worksheets"."deposit_percent" <= 100)),
	CONSTRAINT "quotation_worksheets_revision_check" CHECK ("quotation_worksheets"."revision" > 0)
);
--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "quotation_worksheet_lines" ADD CONSTRAINT "quotation_worksheet_lines_worksheet_id_quotation_worksheets_id_fk" FOREIGN KEY ("worksheet_id") REFERENCES "public"."quotation_worksheets"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "quotation_worksheets" ADD CONSTRAINT "quotation_worksheets_devis_id_devis_id_fk" FOREIGN KEY ("devis_id") REFERENCES "public"."devis"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "quotation_worksheets" ADD CONSTRAINT "quotation_worksheets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "quotation_worksheet_audit_worksheet_idx" ON "quotation_worksheet_audit" USING btree ("worksheet_id","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "quotation_worksheet_lines_worksheet_idx" ON "quotation_worksheet_lines" USING btree ("worksheet_id","position");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "quotation_worksheets_devis_idx" ON "quotation_worksheets" USING btree ("devis_id");--> statement-breakpoint
CREATE OR REPLACE FUNCTION quotation_worksheet_audit_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'quotation_worksheet_audit rows are append-only and cannot be % ', TG_OP
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "quotation_worksheet_audit_immutable" ON "quotation_worksheet_audit";
--> statement-breakpoint
CREATE TRIGGER "quotation_worksheet_audit_immutable" BEFORE UPDATE OR DELETE ON "quotation_worksheet_audit"
  FOR EACH ROW EXECUTE FUNCTION quotation_worksheet_audit_immutable();
