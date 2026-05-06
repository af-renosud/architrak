-- Task #164 — Archidoc mirror sync-set reconciliation.
--
-- Adds the columns needed for the full-sync reconciliation pass in
-- server/archidoc/sync-service.ts so that mirror rows which disappear
-- from the upstream response (because the project/contractor was
-- deleted on Archidoc, OR because the deployment secret
-- ARCHIDOC_BASE_URL was repointed at a different Archidoc backend)
-- are soft-deleted and excluded from the New Project dialog.
--
-- We never hard-delete because Architrak `projects.archidoc_id` and
-- `contractors.archidoc_id` foreign-reference these rows, and operators
-- need the audit trail for any mistakenly-cleared mirror entry.
--
-- `archidoc_projects.is_deleted` already exists (added in 0000) — we
-- only add the matching `deleted_at` audit timestamp + the source
-- backend stamp. `archidoc_contractors` gains all three columns.

ALTER TABLE "archidoc_projects"
  ADD COLUMN IF NOT EXISTS "deleted_at" timestamp,
  ADD COLUMN IF NOT EXISTS "source_base_url" text;

ALTER TABLE "archidoc_contractors"
  ADD COLUMN IF NOT EXISTS "is_deleted" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "deleted_at" timestamp,
  ADD COLUMN IF NOT EXISTS "source_base_url" text;

-- Index the soft-delete column on both tables to keep the
-- "exclude soft-deleted" filter in the storage layer cheap as the
-- mirror grows.
CREATE INDEX IF NOT EXISTS "archidoc_projects_is_deleted_idx"
  ON "archidoc_projects" ("is_deleted");

CREATE INDEX IF NOT EXISTS "archidoc_contractors_is_deleted_idx"
  ON "archidoc_contractors" ("is_deleted");
