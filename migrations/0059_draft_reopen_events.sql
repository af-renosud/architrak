-- Task #346 — append-only audit for "reopen for review" (pending → draft).
--
-- Confirming an AI-extracted draft (devis or invoice) moves it
-- draft → pending. Reopening is the explicit reverse transition so an
-- architect can amend a draft more than once; every reopen must be
-- attributable. Polymorphic (entity_type, entity_id) — no FK by design,
-- mirroring the append-only accounting_state_changes convention.
CREATE TABLE "draft_reopen_events" (
  "id" serial PRIMARY KEY NOT NULL,
  "entity_type" text NOT NULL,
  "entity_id" integer NOT NULL,
  "previous_status" text NOT NULL,
  "reopened_by" text,
  "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX "draft_reopen_events_entity_idx"
  ON "draft_reopen_events" ("entity_type", "entity_id");
