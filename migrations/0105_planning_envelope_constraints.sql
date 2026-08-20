-- Task #650 patch — Planning Envelope defensive constraints + provenance columns
-- Adds missing DB constraints, indexes, and source MIME/size columns.

-- ── planning_revisions: add defensive constraints ─────────────────────────────
-- version > 0
DO $$ BEGIN
  ALTER TABLE "planning_revisions"
    ADD CONSTRAINT "planning_revisions_version_positive_chk" CHECK ("version" > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

-- Unique partial index: only one row per promoted_devis_id (non-null)
CREATE UNIQUE INDEX IF NOT EXISTS "planning_revisions_promoted_devis_id_unique"
  ON "planning_revisions"("promoted_devis_id")
  WHERE "promoted_devis_id" IS NOT NULL;--> statement-breakpoint

-- Reviewed revisions must have reviewer and snapshot absence
DO $$ BEGIN
  ALTER TABLE "planning_revisions"
    ADD CONSTRAINT "planning_revisions_reviewed_audit_chk" CHECK (
      "status" != 'reviewed' OR ("reviewed_by" IS NOT NULL AND "reviewed_at" IS NOT NULL)
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

-- Approved and superseded revisions must retain their immutable approval facts.
DO $$ BEGIN
  ALTER TABLE "planning_revisions"
    ADD CONSTRAINT "planning_revisions_approved_audit_chk" CHECK (
      "status" NOT IN ('approved', 'superseded') OR (
        "approved_by" IS NOT NULL AND "approved_at" IS NOT NULL
        AND "approved_snapshot" IS NOT NULL AND "approved_snapshot_sha256" IS NOT NULL
      )
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

-- Superseded revisions must have superseder
DO $$ BEGIN
  ALTER TABLE "planning_revisions"
    ADD CONSTRAINT "planning_revisions_superseded_audit_chk" CHECK (
      "status" != 'superseded' OR ("superseded_by" IS NOT NULL AND "superseded_at" IS NOT NULL)
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

-- ── planning_revision_lines: defensive constraints ────────────────────────────
-- line_number > 0
DO $$ BEGIN
  ALTER TABLE "planning_revision_lines"
    ADD CONSTRAINT "planning_revision_lines_line_number_positive_chk" CHECK ("line_number" > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

-- total_ht >= 0
DO $$ BEGIN
  ALTER TABLE "planning_revision_lines"
    ADD CONSTRAINT "planning_revision_lines_total_ht_nonneg_chk" CHECK ("total_ht" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

-- unit_price_ht >= 0 if present
DO $$ BEGIN
  ALTER TABLE "planning_revision_lines"
    ADD CONSTRAINT "planning_revision_lines_unit_price_nonneg_chk" CHECK (
      "unit_price_ht" IS NULL OR "unit_price_ht" >= 0
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

-- quantity >= 0 if present
DO $$ BEGIN
  ALTER TABLE "planning_revision_lines"
    ADD CONSTRAINT "planning_revision_lines_quantity_nonneg_chk" CHECK (
      "quantity" IS NULL OR "quantity" >= 0
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

-- ── planning_revision_sources: confidence range + provenance for pdf_upload ──
-- confidence between 0 and 100
DO $$ BEGIN
  ALTER TABLE "planning_revision_sources"
    ADD CONSTRAINT "planning_revision_sources_confidence_range_chk" CHECK (
      "confidence" IS NULL OR ("confidence" >= 0 AND "confidence" <= 100)
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

-- Add mime_type and file_size_bytes columns for provenance
ALTER TABLE "planning_revision_sources"
  ADD COLUMN IF NOT EXISTS "mime_type" text;--> statement-breakpoint
ALTER TABLE "planning_revision_sources"
  ADD COLUMN IF NOT EXISTS "file_size_bytes" integer;--> statement-breakpoint

-- pdf_upload sources must retain complete immutable object provenance.
DO $$ BEGIN
  ALTER TABLE "planning_revision_sources"
    ADD CONSTRAINT "planning_revision_sources_pdf_provenance_chk" CHECK (
      "source_kind" != 'pdf_upload' OR (
        "storage_key" IS NOT NULL AND "file_name" IS NOT NULL AND "file_sha256" IS NOT NULL
        AND "mime_type" IS NOT NULL AND "file_size_bytes" IS NOT NULL
      )
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
