-- Task #410 — warn the architect when ArchiDoc keeps asking for a client
-- link it cannot get. One row per project holding the most recent miss
-- ("expired" / "rotate_required"); a successful lookup deletes the row.
CREATE TABLE "archidoc_link_lookup_misses" (
  "id" serial PRIMARY KEY NOT NULL,
  "project_id" integer NOT NULL,
  "reason" text NOT NULL,
  "last_miss_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
ALTER TABLE "archidoc_link_lookup_misses"
  ADD CONSTRAINT "archidoc_link_lookup_misses_project_id_projects_id_fk"
  FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "archidoc_link_lookup_misses_project_id_idx"
  ON "archidoc_link_lookup_misses" ("project_id");
