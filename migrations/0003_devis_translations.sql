CREATE TABLE IF NOT EXISTS "devis_translations" (
	"devis_id" integer PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"provider" text,
	"model_id" text,
	"header_translated" jsonb,
	"line_translations" jsonb,
	"error_message" text,
	"translated_pdf_storage_key" text,
	"combined_pdf_storage_key" text,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "devis_translations" ADD CONSTRAINT "devis_translations_devis_id_devis_id_fk" FOREIGN KEY ("devis_id") REFERENCES "public"."devis"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
