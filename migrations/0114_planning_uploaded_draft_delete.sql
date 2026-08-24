-- Permit a narrowly guarded hard-delete for disposable PDF-uploaded planning
-- drafts while preserving the existing aggregate cascade and audit protections.
CREATE OR REPLACE FUNCTION guard_planning_uploaded_draft_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  source_sha text;
BEGIN
  -- Aggregate cleanup remains permitted. During project/envelope cascades the
  -- parent chain is already disappearing, even if the revision is still visible.
  IF NOT EXISTS (
    SELECT 1
      FROM planning_envelopes e
      JOIN projects p ON p.id = e.project_id
     WHERE e.id = OLD.envelope_id
  ) THEN
    RETURN OLD;
  END IF;

  -- Serialize against application import/PDF creation, which acquires a shared
  -- lock on the same project row before inserting an import or source.
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
    RAISE EXCEPTION 'uploaded planning drafts on archived projects cannot be deleted'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.status != 'draft'
     OR OLD.reviewed_by IS NOT NULL
     OR OLD.reviewed_at IS NOT NULL
     OR OLD.approved_by IS NOT NULL
     OR OLD.approved_at IS NOT NULL
     OR OLD.approved_snapshot IS NOT NULL
     OR OLD.approved_snapshot_sha256 IS NOT NULL
     OR OLD.supersedes_revision_id IS NOT NULL
     OR OLD.superseded_by IS NOT NULL
     OR OLD.superseded_at IS NOT NULL
     OR OLD.promoted_devis_id IS NOT NULL
     OR OLD.promoted_by IS NOT NULL
     OR OLD.promoted_at IS NOT NULL THEN
    RAISE EXCEPTION 'planning revision % is not a disposable draft', OLD.id
      USING ERRCODE = '23514';
  END IF;

  SELECT s.file_sha256
    INTO source_sha
    FROM planning_revision_sources s
   WHERE s.revision_id = OLD.id
     AND s.source_kind = 'pdf_upload'
     AND s.storage_key IS NOT NULL
     AND s.file_sha256 IS NOT NULL;
  IF source_sha IS NULL THEN
    RAISE EXCEPTION 'planning revision % is not backed by an uploaded PDF', OLD.id
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1 FROM planning_revisions r
     WHERE r.supersedes_revision_id = OLD.id
  ) OR EXISTS (
    SELECT 1 FROM devis d
     WHERE d.source_planning_revision_id = OLD.id
  ) THEN
    RAISE EXCEPTION 'planning revision % has downstream provenance', OLD.id
      USING ERRCODE = '23514';
  END IF;

  -- The application removes the completed import row first. Keeping this guard
  -- prevents ON DELETE SET NULL from corrupting the terminal import shape.
  IF EXISTS (
    SELECT 1 FROM planning_import_jobs j
     WHERE j.revision_id = OLD.id
  ) THEN
    RAISE EXCEPTION 'planning revision % still has linked import history', OLD.id
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
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
DROP TRIGGER IF EXISTS planning_uploaded_draft_delete_guard_trg ON planning_revisions;--> statement-breakpoint
CREATE TRIGGER planning_uploaded_draft_delete_guard_trg
  BEFORE DELETE ON planning_revisions
  FOR EACH ROW EXECUTE FUNCTION guard_planning_uploaded_draft_delete();--> statement-breakpoint