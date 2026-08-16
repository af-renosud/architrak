-- Task #529 — communications-hub "fresh start" archive flags.
--
-- Archive is a VISIBILITY flag only: nothing is deleted, everything stays
-- retrievable behind the hub's Archives toggle. Applies to:
--   - project_communications.archived_at
--   - certificat_payment_suggestions.archived_at
-- The bulk fresh-start action only ever archives SENT communications and
-- already-reviewed (confirmed/dismissed) suggestions older than a chosen
-- cutoff; queued/failed comms and open suggestions are never auto-archived.
ALTER TABLE "project_communications"
  ADD COLUMN "archived_at" timestamp;

ALTER TABLE "certificat_payment_suggestions"
  ADD COLUMN "archived_at" timestamp;

-- The hub's default view filters on "archived_at IS NULL"; partial indexes
-- keep that path cheap as the archive grows.
CREATE INDEX "project_communications_active_idx"
  ON "project_communications" ("created_at")
  WHERE "archived_at" IS NULL;

CREATE INDEX "certificat_payment_suggestions_active_idx"
  ON "certificat_payment_suggestions" ("created_at")
  WHERE "archived_at" IS NULL;
