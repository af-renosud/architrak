-- Planning Envelope database immutability and append-only audit guards.
-- Application checks remain the friendly API perimeter; these triggers prevent
-- an application-role SQL path from mutating approved commercial facts.

CREATE OR REPLACE FUNCTION guard_planning_revision_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
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

DROP TRIGGER IF EXISTS planning_revision_immutable_trg ON planning_revisions;--> statement-breakpoint
CREATE TRIGGER planning_revision_immutable_trg
  BEFORE UPDATE ON planning_revisions
  FOR EACH ROW EXECUTE FUNCTION guard_planning_revision_immutable();--> statement-breakpoint

CREATE OR REPLACE FUNCTION guard_planning_revision_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Permit aggregate cleanup only when the parent envelope is already being
  -- cascaded away (for example, a project hard-delete).
  IF EXISTS (SELECT 1 FROM planning_envelopes WHERE id = OLD.envelope_id) THEN
    RAISE EXCEPTION 'planning revision % cannot be deleted independently', OLD.id
      USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
END;
$$;--> statement-breakpoint

DROP TRIGGER IF EXISTS planning_revision_delete_guard_trg ON planning_revisions;--> statement-breakpoint
CREATE TRIGGER planning_revision_delete_guard_trg
  BEFORE DELETE ON planning_revisions
  FOR EACH ROW EXECUTE FUNCTION guard_planning_revision_delete();--> statement-breakpoint

CREATE OR REPLACE FUNCTION guard_planning_revision_line_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  old_revision_id integer;
  new_revision_id integer;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    old_revision_id := OLD.revision_id;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    new_revision_id := NEW.revision_id;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM planning_revisions
     WHERE id IN (old_revision_id, new_revision_id)
       AND status IN ('approved', 'superseded')
  ) THEN
    RAISE EXCEPTION 'lines of an approved or superseded planning revision are immutable'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

DROP TRIGGER IF EXISTS planning_revision_line_immutable_trg ON planning_revision_lines;--> statement-breakpoint
CREATE TRIGGER planning_revision_line_immutable_trg
  BEFORE INSERT OR UPDATE OR DELETE ON planning_revision_lines
  FOR EACH ROW EXECUTE FUNCTION guard_planning_revision_line_mutation();--> statement-breakpoint

CREATE OR REPLACE FUNCTION guard_planning_revision_source_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- A parent revision cascade is allowed; direct provenance deletion is not.
    IF EXISTS (SELECT 1 FROM planning_revisions WHERE id = OLD.revision_id) THEN
      RAISE EXCEPTION 'planning revision source provenance cannot be deleted'
        USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;

  IF ROW(
    NEW.revision_id,
    NEW.source_kind,
    NEW.storage_key,
    NEW.file_name,
    NEW.file_sha256,
    NEW.mime_type,
    NEW.file_size_bytes,
    NEW.parser_version,
    NEW.provider,
    NEW.model_id,
    NEW.raw_extraction,
    NEW.confidence,
    NEW.warnings,
    NEW.requires_verification,
    NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.revision_id,
    OLD.source_kind,
    OLD.storage_key,
    OLD.file_name,
    OLD.file_sha256,
    OLD.mime_type,
    OLD.file_size_bytes,
    OLD.parser_version,
    OLD.provider,
    OLD.model_id,
    OLD.raw_extraction,
    OLD.confidence,
    OLD.warnings,
    OLD.requires_verification,
    OLD.created_at
  ) THEN
    RAISE EXCEPTION 'planning revision source provenance is immutable'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM planning_revisions
     WHERE id = OLD.revision_id
       AND status IN ('approved', 'superseded')
  ) AND ROW(
    NEW.verified_at,
    NEW.verified_by,
    NEW.verification_note
  ) IS DISTINCT FROM ROW(
    OLD.verified_at,
    OLD.verified_by,
    OLD.verification_note
  ) THEN
    RAISE EXCEPTION 'approved planning source verification is immutable'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

DROP TRIGGER IF EXISTS planning_revision_source_immutable_trg ON planning_revision_sources;--> statement-breakpoint
CREATE TRIGGER planning_revision_source_immutable_trg
  BEFORE UPDATE OR DELETE ON planning_revision_sources
  FOR EACH ROW EXECUTE FUNCTION guard_planning_revision_source_mutation();--> statement-breakpoint

CREATE OR REPLACE FUNCTION guard_planning_revision_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND NOT EXISTS (SELECT 1 FROM planning_revisions WHERE id = OLD.revision_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'planning revision events are append-only'
    USING ERRCODE = '23514';
END;
$$;--> statement-breakpoint

DROP TRIGGER IF EXISTS planning_revision_event_append_only_trg ON planning_revision_events;--> statement-breakpoint
CREATE TRIGGER planning_revision_event_append_only_trg
  BEFORE UPDATE OR DELETE ON planning_revision_events
  FOR EACH ROW EXECUTE FUNCTION guard_planning_revision_event_mutation();--> statement-breakpoint