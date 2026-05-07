-- Task #176 — Structured devis code with lot picker, auto-numbering, and
-- list filters.
--
-- Adds three nullable columns to `devis` so the architect can express the
-- devis code as `{lotRef}.{number}.{description}`:
--   * lot_catalog_id  — FK to the master `lot_catalog` row (NULL for
--                       free-text refs not in the master list).
--   * lot_ref_text    — denormalised lot reference (catalog code or
--                       free-text). Used by the uniqueness index and by
--                       the list-page lot filter so we don't need to
--                       outer-join the catalog at read time.
--   * lot_sequence    — per-project, per-lot integer (1, 2, 3…).
--
-- Uniqueness: a partial unique index on (project_id, lower(lot_ref_text),
-- lot_sequence) prevents duplicate `{lotRef}.{number}` pairs within a
-- project even under concurrent saves. Case-insensitive so FD.1 and fd.1
-- collide. Partial so legacy / draft devis with NULL columns are exempt.
--
-- The composed display string keeps living in the existing `devis_code`
-- column so all read paths and dashboards continue to work unchanged.

ALTER TABLE "devis"
  ADD COLUMN IF NOT EXISTS "lot_catalog_id" integer REFERENCES "lot_catalog"("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "lot_ref_text" text,
  ADD COLUMN IF NOT EXISTS "lot_sequence" integer;

CREATE UNIQUE INDEX IF NOT EXISTS "devis_project_lot_ref_seq_unique"
  ON "devis" ("project_id", lower("lot_ref_text"), "lot_sequence")
  WHERE "lot_ref_text" IS NOT NULL AND "lot_sequence" IS NOT NULL;
