-- Per-line rich-text "context" documents rendered into the translated devis
-- PDF. Keyed by the stable devis_line_items.id (NOT lineNumber and NOT the
-- devis_translations.line_translations jsonb) so force re-translation can
-- never wipe architect-authored context. `revision` backs optimistic
-- concurrency (stale saves are rejected with 409).
CREATE TABLE IF NOT EXISTS "devis_line_contexts" (
  "id" serial PRIMARY KEY NOT NULL,
  "devis_line_item_id" integer NOT NULL,
  "devis_id" integer NOT NULL,
  "document" jsonb NOT NULL,
  "revision" integer DEFAULT 1 NOT NULL,
  "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  CONSTRAINT "devis_line_contexts_devis_line_item_id_unique" UNIQUE("devis_line_item_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "devis_line_context_assets" (
  "id" serial PRIMARY KEY NOT NULL,
  "devis_line_item_id" integer NOT NULL,
  "devis_id" integer NOT NULL,
  "storage_key" text NOT NULL,
  "mime_type" text NOT NULL,
  "size_bytes" integer NOT NULL,
  "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
ALTER TABLE "devis_line_contexts" ADD CONSTRAINT "devis_line_contexts_devis_line_item_id_devis_line_items_id_fk" FOREIGN KEY ("devis_line_item_id") REFERENCES "public"."devis_line_items"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "devis_line_contexts" ADD CONSTRAINT "devis_line_contexts_devis_id_devis_id_fk" FOREIGN KEY ("devis_id") REFERENCES "public"."devis"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "devis_line_context_assets" ADD CONSTRAINT "devis_line_context_assets_devis_line_item_id_devis_line_items_id_fk" FOREIGN KEY ("devis_line_item_id") REFERENCES "public"."devis_line_items"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "devis_line_context_assets" ADD CONSTRAINT "devis_line_context_assets_devis_id_devis_id_fk" FOREIGN KEY ("devis_id") REFERENCES "public"."devis"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "devis_line_contexts_devis_id_idx" ON "devis_line_contexts" ("devis_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "devis_line_context_assets_line_item_idx" ON "devis_line_context_assets" ("devis_line_item_id");
