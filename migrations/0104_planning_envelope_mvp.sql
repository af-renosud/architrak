-- Task #650 — Planning Envelope MVP
-- Five separate tables: planning_envelopes, planning_revisions,
-- planning_revision_lines, planning_revision_sources, planning_revision_events.
-- Plus a nullable sourcePlanningRevisionId column on devis for immutable
-- provenance without creating a Drizzle circular FK.

-- ── planning_envelopes ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "planning_envelopes" (
  "id"         serial PRIMARY KEY,
  "project_id" integer NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "currency"   text    NOT NULL DEFAULT 'EUR',
  "created_at" timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "planning_envelopes_project_id_unique" UNIQUE ("project_id")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "planning_envelopes_project_id_idx" ON "planning_envelopes"("project_id");--> statement-breakpoint

-- ── planning_revisions ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "planning_revisions" (
  "id"                      serial PRIMARY KEY,
  "envelope_id"             integer NOT NULL REFERENCES "planning_envelopes"("id") ON DELETE CASCADE,
  "version"                 integer NOT NULL DEFAULT 1,
  "status"                  text    NOT NULL DEFAULT 'draft',
  -- nullable provenance references
  "contractor_id"           integer REFERENCES "contractors"("id") ON DELETE SET NULL,
  "lot_id"                  integer REFERENCES "lots"("id") ON DELETE SET NULL,
  -- header fields
  "reference"               text,
  "description_fr"          text,
  "document_date"           date,
  "amount_ht"               numeric(12, 2),
  "amount_ttc"              numeric(12, 2),
  "tva_rate_percent"        numeric(5, 2),
  "tva_autoliquidation"     boolean NOT NULL DEFAULT false,
  -- lifecycle links
  "supersedes_revision_id"  integer,  -- FK declared below to avoid Drizzle circular inference
  -- review
  "reviewed_by"             text,
  "reviewed_at"             timestamp,
  -- approval
  "approved_by"             text,
  "approved_at"             timestamp,
  "approved_snapshot"       jsonb,
  "approved_snapshot_sha256" text,
  -- supersede
  "superseded_by"           text,
  "superseded_at"           timestamp,
  -- promotion to devis
  "promoted_devis_id"       integer,  -- FK declared in SQL only (avoids Drizzle circular inference with devis)
  "promoted_by"             text,
  "promoted_at"             timestamp,
  -- creator
  "created_by"              text,
  "created_at"              timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"              timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "planning_revisions_status_chk" CHECK (
    "status" IN ('draft', 'reviewed', 'approved', 'superseded')
  ),
  CONSTRAINT "planning_revisions_amounts_positive_chk" CHECK (
    "amount_ht" IS NULL OR "amount_ht" >= 0
  ),
  CONSTRAINT "planning_revisions_amounts_ttc_ht_chk" CHECK (
    "amount_ttc" IS NULL OR "amount_ht" IS NULL OR "amount_ttc" >= "amount_ht"
  )
);--> statement-breakpoint
-- Circular FK for supersedes_revision_id (SQL-only, not Drizzle)
DO $$ BEGIN
  ALTER TABLE "planning_revisions" ADD CONSTRAINT "planning_revisions_supersedes_revision_id_fk"
    FOREIGN KEY ("supersedes_revision_id") REFERENCES "planning_revisions"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
-- Circular FK for promoted_devis_id (SQL-only, not Drizzle)
DO $$ BEGIN
  ALTER TABLE "planning_revisions" ADD CONSTRAINT "planning_revisions_promoted_devis_id_fk"
    FOREIGN KEY ("promoted_devis_id") REFERENCES "devis"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "planning_revisions_envelope_id_idx" ON "planning_revisions"("envelope_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "planning_revisions_status_idx" ON "planning_revisions"("status");--> statement-breakpoint

-- ── planning_revision_lines ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "planning_revision_lines" (
  "id"              serial PRIMARY KEY,
  "revision_id"     integer NOT NULL REFERENCES "planning_revisions"("id") ON DELETE CASCADE,
  "line_number"     integer NOT NULL,
  "description"     text    NOT NULL,
  "quantity"        numeric(12, 3),
  "unit"            text,
  "unit_price_ht"   numeric(12, 2),
  "total_ht"        numeric(12, 2) NOT NULL,
  "pdf_page_hint"   integer,
  "pdf_bbox"        jsonb,
  CONSTRAINT "planning_revision_lines_revision_line_unique" UNIQUE ("revision_id", "line_number")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "planning_revision_lines_revision_id_idx" ON "planning_revision_lines"("revision_id");--> statement-breakpoint

-- ── planning_revision_sources ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "planning_revision_sources" (
  "id"                    serial PRIMARY KEY,
  "revision_id"           integer NOT NULL REFERENCES "planning_revisions"("id") ON DELETE CASCADE,
  "source_kind"           text    NOT NULL DEFAULT 'manual',
  -- object storage provenance (null for manual)
  "storage_key"           text,
  "file_name"             text,
  "file_sha256"           text,
  -- extraction provenance
  "parser_version"        text,
  "provider"              text,
  "model_id"              text,
  "raw_extraction"        jsonb,
  "confidence"            integer,
  "warnings"              jsonb,
  -- verification gate
  "requires_verification" boolean NOT NULL DEFAULT false,
  "verified_at"           timestamp,
  "verified_by"           text,
  "verification_note"     text,
  "created_at"            timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "planning_revision_sources_source_kind_chk" CHECK (
    "source_kind" IN ('manual', 'pdf_upload')
  ),
  CONSTRAINT "planning_revision_sources_revision_id_unique" UNIQUE ("revision_id")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "planning_revision_sources_revision_id_idx" ON "planning_revision_sources"("revision_id");--> statement-breakpoint

-- ── planning_revision_events (append-only) ────────────────────────────────────
CREATE TABLE IF NOT EXISTS "planning_revision_events" (
  "id"          serial PRIMARY KEY,
  "revision_id" integer NOT NULL REFERENCES "planning_revisions"("id") ON DELETE CASCADE,
  "action"      text    NOT NULL,
  "actor"       text,
  "payload"     jsonb,
  "created_at"  timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "planning_revision_events_revision_id_idx" ON "planning_revision_events"("revision_id");--> statement-breakpoint

-- ── devis.source_planning_revision_id (nullable, immutable provenance) ────────
ALTER TABLE "devis" ADD COLUMN IF NOT EXISTS "source_planning_revision_id" integer;--> statement-breakpoint
-- FK declared SQL-only to avoid Drizzle circular inference
DO $$ BEGIN
  ALTER TABLE "devis" ADD CONSTRAINT "devis_source_planning_revision_id_fk"
    FOREIGN KEY ("source_planning_revision_id") REFERENCES "planning_revisions"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "devis_source_planning_revision_id_unique"
  ON "devis"("source_planning_revision_id")
  WHERE "source_planning_revision_id" IS NOT NULL;--> statement-breakpoint
