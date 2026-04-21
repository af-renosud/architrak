CREATE TABLE IF NOT EXISTS "devis_ref_edits" (
"id" serial PRIMARY KEY NOT NULL,
"devis_id" integer NOT NULL,
"field" text NOT NULL,
"previous_value" text,
"new_value" text,
"edited_by_user_id" integer,
"edited_by_email" text,
"edited_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "devis_ref_edits" ADD CONSTRAINT "devis_ref_edits_devis_id_devis_id_fk" FOREIGN KEY ("devis_id") REFERENCES "public"."devis"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "devis_ref_edits" ADD CONSTRAINT "devis_ref_edits_edited_by_user_id_users_id_fk" FOREIGN KEY ("edited_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "devis_ref_edits_devis_id_idx" ON "devis_ref_edits" USING btree ("devis_id");
