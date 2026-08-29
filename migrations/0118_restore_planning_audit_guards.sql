-- Restore every audit/provenance protection from 0113 after broadening
-- planning-candidate deletion. The only new exception permits the FK-driven
-- unlink of a surviving successor when its predecessor is deliberately deleted.
CREATE OR REPLACE FUNCTION guard_planning_revision_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM planning_envelopes e
      JOIN projects p ON p.id = e.project_id
     WHERE e.id = OLD.envelope_id
  ) THEN
    RETURN NEW;
  END IF;

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
    IF OLD.status = 'approved' AND NEW.status = 'approved'
       AND ROW(NEW.superseded_by, NEW.superseded_at)
           IS DISTINCT FROM ROW(OLD.superseded_by, OLD.superseded_at) THEN
      RAISE EXCEPTION 'planning revision % supersession audit cannot be pre-stamped', OLD.id
        USING ERRCODE = '23514';
    END IF;
    IF OLD.status = 'approved' AND NEW.status = 'superseded'
       AND (NEW.superseded_by IS NULL OR NEW.superseded_at IS NULL) THEN
      RAISE EXCEPTION 'planning revision % supersession audit is incomplete', OLD.id
        USING ERRCODE = '23514';
    END IF;
    IF OLD.status = 'superseded' THEN
      IF NEW.status <> 'superseded' THEN
        RAISE EXCEPTION 'superseded planning revision % is terminal', OLD.id
          USING ERRCODE = '23514';
      END IF;
      IF ROW(NEW.superseded_by, NEW.superseded_at)
         IS DISTINCT FROM ROW(OLD.superseded_by, OLD.superseded_at) THEN
        RAISE EXCEPTION 'planning revision % supersession audit is immutable', OLD.id
          USING ERRCODE = '23514';
      END IF;
    END IF;

    IF OLD.promoted_devis_id IS NULL THEN
      IF NEW.promoted_devis_id IS NULL THEN
        IF ROW(NEW.promoted_by, NEW.promoted_at)
           IS DISTINCT FROM ROW(OLD.promoted_by, OLD.promoted_at) THEN
          RAISE EXCEPTION 'planning revision % promotion audit cannot be pre-stamped', OLD.id
            USING ERRCODE = '23514';
        END IF;
      ELSE
        IF NEW.promoted_by IS NULL OR NEW.promoted_at IS NULL THEN
          RAISE EXCEPTION 'planning revision % promotion audit is incomplete', OLD.id
            USING ERRCODE = '23514';
        END IF;
        IF NOT EXISTS (
          SELECT 1
            FROM devis d
            JOIN planning_envelopes e ON e.id = NEW.envelope_id
           WHERE d.id = NEW.promoted_devis_id
             AND d.project_id = e.project_id
             AND d.source_planning_revision_id = NEW.id
             AND d.contractor_id = NEW.contractor_id
             AND d.lot_id IS NOT DISTINCT FROM NEW.lot_id
             AND d.amount_ht = NEW.amount_ht
             AND d.amount_ttc = NEW.amount_ttc
             AND d.status = 'draft'
             AND d.accounting_state = 'provisional'
             AND d.pdf_storage_key IS NOT DISTINCT FROM (NEW.approved_snapshot #>> '{source,storageKey}')
             AND d.pdf_file_name IS NOT DISTINCT FROM (NEW.approved_snapshot #>> '{source,fileName}')
             AND d.ai_confidence IS NOT DISTINCT FROM NULLIF(NEW.approved_snapshot #>> '{source,confidence}', '')::integer
             AND d.ai_extracted_data IS NOT DISTINCT FROM NULLIF(
               NEW.approved_snapshot #> '{source,rawExtraction}', 'null'::jsonb
             )
             AND d.validation_warnings IS NOT DISTINCT FROM NULLIF(
               NEW.approved_snapshot #> '{source,warnings}', 'null'::jsonb
             )
             AND (
               SELECT count(*) FROM devis_line_items li WHERE li.devis_id = d.id
             ) = jsonb_array_length(COALESCE(NEW.approved_snapshot -> 'lines', '[]'::jsonb))
             AND NOT EXISTS (
               SELECT 1
                 FROM jsonb_array_elements(COALESCE(NEW.approved_snapshot -> 'lines', '[]'::jsonb)) snap_line
                WHERE NOT EXISTS (
                  SELECT 1
                    FROM devis_line_items li
                   WHERE li.devis_id = d.id
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
          RAISE EXCEPTION 'planning revision % promotion target does not match its approved snapshot', OLD.id
            USING ERRCODE = '23514';
        END IF;
      END IF;
    ELSIF ROW(
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