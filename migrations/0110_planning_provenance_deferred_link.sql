-- Attach Planning provenance only after the complete Live devis exists, and
-- require both sides of the link to be present at transaction commit.
CREATE OR REPLACE FUNCTION guard_devis_planning_source()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.source_planning_revision_id IS NOT NULL THEN
      RAISE EXCEPTION 'devis planning provenance must be attached after all lines are inserted'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.source_planning_revision_id IS NOT DISTINCT FROM OLD.source_planning_revision_id THEN
    RETURN NEW;
  END IF;

  -- Permit FK cleanup only while the project aggregate is being deleted.
  IF NOT EXISTS (SELECT 1 FROM projects WHERE id = OLD.project_id) THEN
    RETURN NEW;
  END IF;

  IF OLD.source_planning_revision_id IS NOT NULL THEN
    RAISE EXCEPTION 'devis % planning provenance is immutable', OLD.id
      USING ERRCODE = '23514';
  END IF;

  IF NEW.source_planning_revision_id IS NULL OR NOT EXISTS (
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
       AND (
         SELECT count(*)
           FROM devis_line_items li
          WHERE li.devis_id = NEW.id
       ) = jsonb_array_length(COALESCE(r.approved_snapshot -> 'lines', '[]'::jsonb))
       AND NOT EXISTS (
         SELECT 1
           FROM jsonb_array_elements(COALESCE(r.approved_snapshot -> 'lines', '[]'::jsonb)) snap_line
          WHERE NOT EXISTS (
            SELECT 1
              FROM devis_line_items li
             WHERE li.devis_id = NEW.id
               AND li.line_number = (snap_line ->> 'lineNumber')::integer
               AND li.description = snap_line ->> 'description'
               AND li.quantity IS NOT DISTINCT FROM (snap_line ->> 'quantity')::numeric
               AND li.unit IS NOT DISTINCT FROM snap_line ->> 'unit'
               AND li.unit_price_ht IS NOT DISTINCT FROM (snap_line ->> 'unitPriceHt')::numeric
               AND li.total_ht = (snap_line ->> 'totalHt')::numeric
               AND li.pdf_page_hint IS NOT DISTINCT FROM (snap_line ->> 'pdfPageHint')::integer
               AND li.pdf_bbox IS NOT DISTINCT FROM NULLIF(snap_line -> 'pdfBbox', 'null'::jsonb)
          )
       )
  ) THEN
    RAISE EXCEPTION 'devis planning provenance does not match the complete approved snapshot'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION assert_devis_planning_reciprocal_link()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  current_source_revision_id integer;
BEGIN
  SELECT source_planning_revision_id
    INTO current_source_revision_id
    FROM devis
   WHERE id = NEW.id;

  IF NOT FOUND OR current_source_revision_id IS NULL THEN
    RETURN NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM planning_revisions
     WHERE id = current_source_revision_id
       AND promoted_devis_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'devis % planning provenance is missing its reciprocal promotion link', NEW.id
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$$;--> statement-breakpoint

DROP TRIGGER IF EXISTS devis_planning_reciprocal_link_trg ON devis;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER devis_planning_reciprocal_link_trg
  AFTER INSERT OR UPDATE ON devis
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_devis_planning_reciprocal_link();--> statement-breakpoint