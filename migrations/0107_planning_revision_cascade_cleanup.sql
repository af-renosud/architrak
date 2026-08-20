-- Permit project-level aggregate deletion to run FK cleanup while retaining
-- approved-revision immutability for every live project.
CREATE OR REPLACE FUNCTION guard_planning_revision_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- During ON DELETE CASCADE from projects, the project row is already gone.
  -- FK cleanup may null promoted_devis_id before the envelope/revision cascades.
  IF NOT EXISTS (
    SELECT 1
      FROM planning_envelopes e
      JOIN projects p ON p.id = e.project_id
     WHERE e.id = OLD.envelope_id
  ) THEN
    RETURN NEW;
  END IF;

  IF OLD.status IN ('approved', 'superseded') THEN
    IF ROW(
      NEW.envelope_id,
      NEW.contractor_id,
      NEW.lot_id,
      NEW.reference,
      NEW.description_fr,
      NEW.document_date,
      NEW.amount_ht,
      NEW.amount_ttc,
      NEW.tva_rate_percent,
      NEW.tva_autoliquidation,
      NEW.supersedes_revision_id,
      NEW.reviewed_by,
      NEW.reviewed_at,
      NEW.approved_by,
      NEW.approved_at,
      NEW.approved_snapshot,
      NEW.approved_snapshot_sha256,
      NEW.created_by,
      NEW.created_at
    ) IS DISTINCT FROM ROW(
      OLD.envelope_id,
      OLD.contractor_id,
      OLD.lot_id,
      OLD.reference,
      OLD.description_fr,
      OLD.document_date,
      OLD.amount_ht,
      OLD.amount_ttc,
      OLD.tva_rate_percent,
      OLD.tva_autoliquidation,
      OLD.supersedes_revision_id,
      OLD.reviewed_by,
      OLD.reviewed_at,
      OLD.approved_by,
      OLD.approved_at,
      OLD.approved_snapshot,
      OLD.approved_snapshot_sha256,
      OLD.created_by,
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
      NEW.promoted_devis_id,
      NEW.promoted_by,
      NEW.promoted_at
    ) IS DISTINCT FROM ROW(
      OLD.promoted_devis_id,
      OLD.promoted_by,
      OLD.promoted_at
    ) THEN
      RAISE EXCEPTION 'planning revision % promotion provenance is immutable', OLD.id
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint