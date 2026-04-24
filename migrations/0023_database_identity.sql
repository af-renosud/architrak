-- Task #137: database identity sentinel.
--
-- A single-row metadata table whose `value` column tags the database
-- with a stable name ("architrak-prod" or "architrak-dev"). Boot
-- check `server/operations/database-identity-check.ts` reads this
-- row and refuses to start the app if the value disagrees with what
-- the URL host fingerprint claims, closing the trap surfaced by
-- ArchiDoc Task #294 (PROD_DATABASE_URL silently pointing at the
-- wrong Neon endpoint while every shape-based safety check passes).
--
-- The migration ONLY creates the table. The first boot after deploy
-- auto-seeds the `name` row based on URL-host comparison against
-- EXPECTED_PROD_HOST (in scripts/lib/database-identity.ts). Subsequent
-- boots verify the row.
--
-- IMPORTANT: this table is intentionally NOT in shared/schema.ts —
-- it is operational metadata, managed by the boot path and the
-- destructive scripts. Mirrors how `drizzle.__drizzle_migrations`
-- is also outside the application schema.
CREATE TABLE IF NOT EXISTS "__database_identity" (
  "id" text PRIMARY KEY NOT NULL,
  "value" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
