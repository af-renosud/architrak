-- Task #296 (review hardening): race-safe PDF cache publication.
-- A per-line context save bumps contexts_version atomically with clearing
-- the cached PDF keys; cache publication is a conditional UPDATE guarded by
-- the version captured before generation, so a PDF generated from stale
-- contexts can never be (re)published as the cached artifact.
ALTER TABLE "devis_translations"
  ADD COLUMN IF NOT EXISTS "contexts_version" integer NOT NULL DEFAULT 0;
