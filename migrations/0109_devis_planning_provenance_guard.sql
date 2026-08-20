-- Keep the Live devis -> Planning revision provenance link immutable and only
-- allow its initial value on an exact approved-snapshot promotion candidate.
CREATE OR REPLACE FUNCTION guard_devis_planning_source()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.source_planning_revision_id IS DISTINCT FROM OLD.source_planning_revision_id THEN
      -- Permit FK cleanup only while the project aggregate is being deleted.
      IF NOT EXISTS (SELECT 1 FROM projects WHERE id = OLD.project_id) THEN
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'devis % planning provenance is immutable', OLD.id
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.source_planning_revision_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM planning_revisions r
      JOIN planning_envelopes e ON e.id = r.envelope_id
     WHERE r.id = NEW.source_planning_revision_id
       AND r.status = 'approved'
       AND r.promoted_devis_id IS NULL
       AND e.project_id = NEW.project_id
       AND r.contractor_id = NEW.contractor_id
       AND r.lot_id IS NOT DISTINCT FROM NEW.lot_id
       AND r.amount_ht = NEW.amount_ht
       AND r.amount_ttc = NEW.amount_ttc
       AND NEW.status = 'draft'
       AND NEW.accounting_state = 'provisional'
       AND NEW.devis_code = COALESCE(r.reference, 'PLAN-' || r.id::text)
       AND NEW.devis_number IS NOT DISTINCT FROM r.reference
       AND NEW.description_fr = COALESCE(r.description_fr, r.reference, 'Devis from planning revision')
       AND NEW.pdf_storage_key IS NOT DISTINCT FROM (r.approved_snapshot #>> '{source,storageKey}')
       AND NEW.pdf_file_name IS NOT DISTINCT FROM (r.approved_snapshot #>> '{source,fileName}')
       AND NEW.ai_confidence IS NOT DISTINCT FROM NULLIF(r.approved_snapshot #>> '{source,confidence}', '')::integer
       AND NEW.ai_extracted_data IS NOT DISTINCT FROM NULLIF(
         r.approved_snapshot #> '{source,rawExtraction}',
         'null'::jsonb
       )
       AND NEW.validation_warnings IS NOT DISTINCT FROM NULLIF(
         r.approved_snapshot #> '{source,warnings}',
         'null'::jsonb
       )
  ) THEN
    RAISE EXCEPTION 'devis planning provenance does not match an approved snapshot'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

DROP TRIGGER IF EXISTS devis_planning_source_guard_trg ON devis;--> statement-breakpoint
CREATE TRIGGER devis_planning_source_guard_trg
  BEFORE INSERT OR UPDATE OF source_planning_revision_id ON devis
  FOR EACH ROW EXECUTE FUNCTION guard_devis_planning_source();--> statement-breakpoint