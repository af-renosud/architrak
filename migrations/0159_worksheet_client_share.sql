CREATE TABLE IF NOT EXISTS "client_worksheet_comments" (
	"id" serial PRIMARY KEY NOT NULL,
	"release_id" integer NOT NULL,
	"project_id" integer NOT NULL,
	"token_id" integer,
	"author_email" text NOT NULL,
	"author_name" text,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"acknowledged_by_user_id" integer,
	CONSTRAINT "client_worksheet_comments_body_check" CHECK (char_length("client_worksheet_comments"."body") BETWEEN 1 AND 5000)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "client_worksheet_releases" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"devis_id" integer NOT NULL,
	"worksheet_id" integer NOT NULL,
	"worksheet_revision" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_sha256" text NOT NULL,
	"sealed_by_user_id" integer,
	"sealed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"withdrawn_at" timestamp with time zone,
	"withdrawn_by_user_id" integer
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "worksheet_revision_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"devis_id" integer NOT NULL,
	"worksheet_id" integer NOT NULL,
	"worksheet_revision" integer NOT NULL,
	"request_id" text NOT NULL,
	"changes" jsonb NOT NULL,
	"agreed_lines" jsonb NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"recipient_email" text NOT NULL,
	"communication_id" integer,
	"created_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "quotation_worksheet_audit" DROP CONSTRAINT IF EXISTS "quotation_worksheet_audit_action_check";--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "client_worksheet_comments" ADD CONSTRAINT "client_worksheet_comments_release_id_client_worksheet_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."client_worksheet_releases"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "client_worksheet_comments" ADD CONSTRAINT "client_worksheet_comments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "client_worksheet_releases" ADD CONSTRAINT "client_worksheet_releases_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "client_worksheet_releases" ADD CONSTRAINT "client_worksheet_releases_devis_id_devis_id_fk" FOREIGN KEY ("devis_id") REFERENCES "public"."devis"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "client_worksheet_releases" ADD CONSTRAINT "client_worksheet_releases_worksheet_id_quotation_worksheets_id_fk" FOREIGN KEY ("worksheet_id") REFERENCES "public"."quotation_worksheets"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "worksheet_revision_requests" ADD CONSTRAINT "worksheet_revision_requests_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "worksheet_revision_requests" ADD CONSTRAINT "worksheet_revision_requests_devis_id_devis_id_fk" FOREIGN KEY ("devis_id") REFERENCES "public"."devis"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "worksheet_revision_requests" ADD CONSTRAINT "worksheet_revision_requests_worksheet_id_quotation_worksheets_id_fk" FOREIGN KEY ("worksheet_id") REFERENCES "public"."quotation_worksheets"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "worksheet_revision_requests" ADD CONSTRAINT "worksheet_revision_requests_communication_id_project_communications_id_fk" FOREIGN KEY ("communication_id") REFERENCES "public"."project_communications"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "client_worksheet_comments_release_idx" ON "client_worksheet_comments" USING btree ("release_id","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "client_worksheet_releases_project_idx" ON "client_worksheet_releases" USING btree ("project_id","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "client_worksheet_releases_worksheet_idx" ON "client_worksheet_releases" USING btree ("worksheet_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "worksheet_revision_requests_request_id_idx" ON "worksheet_revision_requests" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "worksheet_revision_requests_worksheet_idx" ON "worksheet_revision_requests" USING btree ("worksheet_id","id");--> statement-breakpoint
ALTER TABLE "quotation_worksheet_audit" ADD CONSTRAINT "quotation_worksheet_audit_action_check" CHECK ("quotation_worksheet_audit"."action" IN ('create','duplicate','update_line','add_line','remove_line','restore_line','delete_line','update_settings','share_client','withdraw_client','revision_request'));--> statement-breakpoint
CREATE OR REPLACE FUNCTION client_worksheet_releases_sealed() RETURNS trigger AS $$
BEGIN
  IF NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.devis_id IS DISTINCT FROM OLD.devis_id
    OR NEW.worksheet_id IS DISTINCT FROM OLD.worksheet_id OR NEW.worksheet_revision IS DISTINCT FROM OLD.worksheet_revision
    OR NEW.payload IS DISTINCT FROM OLD.payload OR NEW.payload_sha256 IS DISTINCT FROM OLD.payload_sha256
    OR NEW.sealed_by_user_id IS DISTINCT FROM OLD.sealed_by_user_id OR NEW.sealed_at IS DISTINCT FROM OLD.sealed_at
    OR (OLD.withdrawn_at IS NOT NULL AND (NEW.withdrawn_at IS DISTINCT FROM OLD.withdrawn_at
      OR NEW.withdrawn_by_user_id IS DISTINCT FROM OLD.withdrawn_by_user_id)) THEN
    RAISE EXCEPTION 'client_worksheet_releases rows are sealed; only a one-time withdrawal may be recorded'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "client_worksheet_releases_sealed" ON "client_worksheet_releases";
--> statement-breakpoint
CREATE TRIGGER "client_worksheet_releases_sealed" BEFORE UPDATE ON "client_worksheet_releases"
  FOR EACH ROW EXECUTE FUNCTION client_worksheet_releases_sealed();
