-- Sealed, append-only copies of exactly what a client can see for a
-- quotation (frozen page content, copied context images, copied EN+FR
-- package PDF). Client surfaces serve ONLY these rows. No FKs to devis /
-- projects on purpose: the audit record must outlive any later deletion.
CREATE TABLE IF NOT EXISTS "client_quotation_releases" (
  "id" serial PRIMARY KEY,
  "project_id" integer NOT NULL,
  "devis_id" integer NOT NULL,
  "devis_code" text NOT NULL,
  "reason" text NOT NULL,
  "content_version" text NOT NULL,
  "payload" jsonb NOT NULL,
  "images" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "package_storage_key" text,
  "package_sha256" text,
  "package_bytes" integer,
  "original_storage_key" text,
  "original_sha256" text,
  "sealed_by_user_id" integer,
  "sealed_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "client_quotation_releases" ADD CONSTRAINT "client_quotation_releases_reason_check"
    CHECK ("reason" IN ('publish','update','client_link','backfill'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "client_quotation_releases" ADD CONSTRAINT "client_quotation_releases_package_check"
    CHECK (("package_storage_key" IS NULL AND "package_sha256" IS NULL AND "package_bytes" IS NULL)
        OR ("package_storage_key" IS NOT NULL AND "package_sha256" IS NOT NULL AND "package_bytes" > 0));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "client_quotation_releases_devis_idx" ON "client_quotation_releases" ("devis_id", "id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "client_quotation_releases_project_idx" ON "client_quotation_releases" ("project_id");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION client_quotation_releases_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'client_quotation_releases rows are sealed and cannot be % ', TG_OP
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "client_quotation_releases_immutable" ON "client_quotation_releases";
--> statement-breakpoint
CREATE TRIGGER "client_quotation_releases_immutable" BEFORE UPDATE OR DELETE ON "client_quotation_releases"
  FOR EACH ROW EXECUTE FUNCTION client_quotation_releases_immutable();
