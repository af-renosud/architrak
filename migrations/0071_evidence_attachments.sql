-- Task #449 — Evidence attachments: retain signed "Situation de travaux"
-- and "Bon de commande" PDFs and attach them to their records.
--
-- 1. situations: source-PDF provenance columns (storage key, filename,
--    uploaded/confirmed metadata, nullable FK back to the intake document).
--    Server-written only; the generic PATCH strips them.
-- 2. marche_documents: new table for marché-level evidence (kind
--    'commande'), with optional devis/marché links, intake provenance and
--    a draft→confirmed state. No DB enums by schema convention.

ALTER TABLE "situations" ADD COLUMN IF NOT EXISTS "source_storage_key" text;
ALTER TABLE "situations" ADD COLUMN IF NOT EXISTS "source_file_name" text;
ALTER TABLE "situations" ADD COLUMN IF NOT EXISTS "source_uploaded_at" timestamp;
ALTER TABLE "situations" ADD COLUMN IF NOT EXISTS "source_uploaded_by" text;
ALTER TABLE "situations" ADD COLUMN IF NOT EXISTS "source_confirmed_at" timestamp;
ALTER TABLE "situations" ADD COLUMN IF NOT EXISTS "source_confirmed_by" text;
ALTER TABLE "situations" ADD COLUMN IF NOT EXISTS "source_intake_document_id" integer;

DO $$ BEGIN
  ALTER TABLE "situations"
    ADD CONSTRAINT "situations_source_intake_document_id_project_intake_documents_id_fk"
    FOREIGN KEY ("source_intake_document_id") REFERENCES "project_intake_documents"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "situations_source_intake_document_id_idx"
  ON "situations" ("source_intake_document_id");

CREATE TABLE IF NOT EXISTS "marche_documents" (
  "id" serial PRIMARY KEY NOT NULL,
  "project_id" integer NOT NULL,
  "kind" text DEFAULT 'commande' NOT NULL,
  "storage_key" text NOT NULL,
  "file_name" text NOT NULL,
  "devis_id" integer,
  "marche_id" integer,
  "source_intake_document_id" integer,
  "extracted_data" jsonb,
  "status" text DEFAULT 'draft' NOT NULL,
  "uploaded_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "uploaded_by" text,
  "confirmed_at" timestamp,
  "confirmed_by" text,
  "notes" text,
  "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL
);

DO $$ BEGIN
  ALTER TABLE "marche_documents"
    ADD CONSTRAINT "marche_documents_project_id_projects_id_fk"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "marche_documents"
    ADD CONSTRAINT "marche_documents_devis_id_devis_id_fk"
    FOREIGN KEY ("devis_id") REFERENCES "devis"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "marche_documents"
    ADD CONSTRAINT "marche_documents_marche_id_marches_id_fk"
    FOREIGN KEY ("marche_id") REFERENCES "marches"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "marche_documents"
    ADD CONSTRAINT "marche_documents_source_intake_document_id_project_intake_documents_id_fk"
    FOREIGN KEY ("source_intake_document_id") REFERENCES "project_intake_documents"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "marche_documents_project_id_idx" ON "marche_documents" ("project_id");
CREATE INDEX IF NOT EXISTS "marche_documents_devis_id_idx" ON "marche_documents" ("devis_id");
CREATE INDEX IF NOT EXISTS "marche_documents_marche_id_idx" ON "marche_documents" ("marche_id");
CREATE INDEX IF NOT EXISTS "marche_documents_source_intake_document_id_idx" ON "marche_documents" ("source_intake_document_id");
