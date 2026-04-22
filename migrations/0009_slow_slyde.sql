CREATE TABLE IF NOT EXISTS "invoice_ref_edits" (
	"id" serial PRIMARY KEY NOT NULL,
	"invoice_id" integer NOT NULL,
	"field" text NOT NULL,
	"previous_value" text,
	"new_value" text,
	"edited_by_user_id" integer,
	"edited_by_email" text,
	"edited_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "invoice_ref_edits" ADD CONSTRAINT "invoice_ref_edits_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "invoice_ref_edits" ADD CONSTRAINT "invoice_ref_edits_edited_by_user_id_users_id_fk" FOREIGN KEY ("edited_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invoice_ref_edits_invoice_id_idx" ON "invoice_ref_edits" USING btree ("invoice_id");
