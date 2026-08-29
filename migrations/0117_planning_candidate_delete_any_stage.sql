-- Planning quotations are budget-working records, so any unpromoted candidate
-- may be removed regardless of its review/approval/revision-history stage.
-- Promotion to Live Delivery remains the permanent deletion boundary.

CREATE TABLE IF NOT EXISTS "planning_revision_line_reviews" (
  "id" serial PRIMARY KEY NOT NULL,
  "line_id" integer NOT NULL,
  "status" text DEFAULT 'unchecked' NOT NULL,
  "notes" text,
  "reviewed_by" text,
  "reviewed_at" timestamp,
  "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  CONSTRAINT "planning_revision_line_reviews_line_id_unique" UNIQUE("line_id"),
  CONSTRAINT "planning_revision_line_reviews_status_chk"
    CHECK ("status" IN ('unchecked', 'green', 'amber', 'red'))
);--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "planning_revision_line_reviews"
    ADD CONSTRAINT "planning_revision_line_reviews_line_id_fk"
    FOREIGN KEY ("line_id") REFERENCES "planning_revision_lines"("id")
    ON DELETE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "planning_revision_line_reviews_line_id_idx"
  ON "planning_revision_line_reviews" USING btree ("line_id");--> statement-breakpoint

CREATE OR REPLACE FUNCTION guard_planning_revision_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- During ON DELETE CASCADE from projects, the project row is already gone.
  IF NOT EXISTS (
    SELECT 1
      FROM planning_envelopes e
      JOIN projects p ON p.id = e.project_id
     WHERE e.id = OLD.envelope_id
  ) THEN
    RETURN NEW;
  END IF;

  -- ON DELETE SET NULL detaches a surviving successor from a planning
  -- candidate that was deliberately removed. No other immutable field may
  -- change through this exception.
  IF OLD.supersedes_revision_id IS NOT NULL
     AND NEW.supersedes_revision_id IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM planning_revisions
        WHERE id = OLD.supersedes_revision_id
     )
     AND (to_jsonb(NEW) - 'supersedes_revision_id')
         = (to_jsonb(OLD) - 'supersedes_revision_id') THEN
    RETURN NEW;
  END IF;

  IF OLD.status IN ('approved', 'superseded') THEN
    IF ROW(
      NEW.envelope_id, NEW.contractor_id, NEW.lot_id,
      NEW.archidoc_technical_lot_id, NEW.reference, NEW.description_fr,
      NEW.document_date, NEW.amount_ht, NEW.amount_ttc, NEW.tva_rate_percent,
      NEW.tva_autoliquidation, NEW.supersedes_revision_id, NEW.reviewed_by,
      NEW.reviewed_at, NEW.approved_by, NEW.approved_at,
      NEW.approved_snapshot, NEW.approved_snapshot_sha256, NEW.created_by,
      NEW.created_at
    ) IS DISTINCT FROM ROW(
      OLD.envelope_id, OLD.contractor_id, OLD.lot_id,
      OLD.archidoc_technical_lot_id, OLD.reference, OLD.description_fr,
      OLD.document_date, OLD.amount_ht, OLD.amount_ttc, OLD.tva_rate_percent,
      OLD.tva_autoliquidation, OLD.supersedes_revision_id, OLD.reviewed_by,
      OLD.reviewed_at, OLD.approved_by, OLD.approved_at,
      OLD.approved_snapshot, OLD.approved_snapshot_sha256, OLD.created_by,
      OLD.created_at
    ) THEN
      RAISE EXCEPTION 'approved planning revision % is immutable', OLD.id
        USING ERRCODE = '23514';
    END IF;

    IF OLD.status = 'approved' AND NEW.status NOT IN ('approved', 'superseded') THEN
      RAISE EXCEPTION 'approved planning revision % cannot return to %', OLD.id, NEW.status
        USING ERRCODE = '23514';
    END IF;
    IF OLD.status = 'superseded' AND NEW.status <> 'superseded' THEN
      RAISE EXCEPTION 'superseded planning revision % is terminal', OLD.id
        USING ERRCODE = '23514';
    END IF;

    IF OLD.promoted_devis_id IS NOT NULL AND ROW(
      NEW.promoted_devis_id, NEW.promoted_by, NEW.promoted_at
    ) IS DISTINCT FROM ROW(
      OLD.promoted_devis_id, OLD.promoted_by, OLD.promoted_at
    ) THEN
      RAISE EXCEPTION 'planning revision % promotion provenance is immutable', OLD.id
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION guard_planning_candidate_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  source_sha text;
BEGIN
  -- Preserve project/envelope aggregate cleanup.
  IF NOT EXISTS (
    SELECT 1
      FROM planning_envelopes e
      JOIN projects p ON p.id = e.project_id
     WHERE e.id = OLD.envelope_id
  ) THEN
    RETURN OLD;
  END IF;

  -- Serialize against imports and other planning mutations.
  PERFORM 1
    FROM planning_envelopes e
    JOIN projects p ON p.id = e.project_id
   WHERE e.id = OLD.envelope_id
   FOR UPDATE OF p;

  IF EXISTS (
    SELECT 1
      FROM planning_envelopes e
      JOIN projects p ON p.id = e.project_id
     WHERE e.id = OLD.envelope_id
       AND p.archived_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'planning candidates on archived projects cannot be deleted'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.promoted_devis_id IS NOT NULL
     OR OLD.promoted_by IS NOT NULL
     OR OLD.promoted_at IS NOT NULL
     OR EXISTS (
       SELECT 1 FROM devis d
        WHERE d.source_planning_revision_id = OLD.id
     ) THEN
    RAISE EXCEPTION 'planning revision % has Live Delivery provenance', OLD.id
      USING ERRCODE = '23514';
  END IF;

  -- The application removes linked terminal imports first.
  IF EXISTS (
    SELECT 1 FROM planning_import_jobs j
     WHERE j.revision_id = OLD.id
  ) THEN
    RAISE EXCEPTION 'planning revision % still has linked import history', OLD.id
      USING ERRCODE = '23514';
  END IF;

  SELECT s.file_sha256
    INTO source_sha
    FROM planning_revision_sources s
   WHERE s.revision_id = OLD.id;

  IF source_sha IS NOT NULL AND EXISTS (
    SELECT 1
      FROM planning_import_jobs j
      JOIN planning_envelopes e ON e.project_id = j.project_id
     WHERE e.id = OLD.envelope_id
       AND j.file_sha256 = source_sha
       AND j.status = 'processing'
  ) THEN
    RAISE EXCEPTION 'planning revision % PDF is still being processed', OLD.id
      USING ERRCODE = '23514';
  END IF;

  RETURN OLD;
END;
$$;--> statement-breakpoint

DROP TRIGGER IF EXISTS planning_revision_delete_guard_trg ON planning_revisions;--> statement-breakpoint
DROP TRIGGER IF EXISTS planning_candidate_delete_guard_trg ON planning_revisions;--> statement-breakpoint
DROP TRIGGER IF EXISTS planning_uploaded_draft_delete_guard_trg ON planning_revisions;--> statement-breakpoint
CREATE TRIGGER planning_uploaded_draft_delete_guard_trg
  BEFORE DELETE ON planning_revisions
  FOR EACH ROW EXECUTE FUNCTION guard_planning_candidate_delete();--> statement-breakpoint