CREATE TABLE IF NOT EXISTS "planning_import_jobs" (
  "id" serial PRIMARY KEY NOT NULL,
  "project_id" integer NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "file_name" text NOT NULL,
  "file_sha256" text NOT NULL,
  "mime_type" text NOT NULL,
  "file_size_bytes" integer NOT NULL,
  "status" text DEFAULT 'processing' NOT NULL,
  "stage" text DEFAULT 'accepted' NOT NULL,
  "revision_id" integer REFERENCES "planning_revisions"("id") ON DELETE SET NULL,
  "error_code" text,
  "error_message" text,
  "created_by" text NOT NULL,
  "started_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "completed_at" timestamp,
  CONSTRAINT "planning_import_jobs_sha256_chk"
    CHECK ("file_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "planning_import_jobs_file_size_chk"
    CHECK ("file_size_bytes" > 0 AND "file_size_bytes" <= 26214400),
  CONSTRAINT "planning_import_jobs_status_chk"
    CHECK ("status" IN ('processing', 'succeeded', 'failed', 'stale')),
  CONSTRAINT "planning_import_jobs_stage_chk"
    CHECK ("stage" IN ('accepted', 'extracting', 'validating', 'storing', 'saving', 'complete')),
  CONSTRAINT "planning_import_jobs_terminal_shape_chk"
    CHECK (
      (
        "status" = 'processing'
        AND "stage" != 'complete'
        AND "revision_id" IS NULL
        AND "completed_at" IS NULL
        AND "error_code" IS NULL
        AND "error_message" IS NULL
      )
      OR (
        "status" = 'succeeded'
        AND "stage" = 'complete'
        AND "revision_id" IS NOT NULL
        AND "completed_at" IS NOT NULL
        AND "error_code" IS NULL
        AND "error_message" IS NULL
      )
      OR (
        "status" IN ('failed', 'stale')
        AND "stage" != 'complete'
        AND "revision_id" IS NULL
        AND "completed_at" IS NOT NULL
        AND "error_code" IS NOT NULL
        AND "error_message" IS NOT NULL
      )
    )
);--> statement-breakpoint

-- CREATE TABLE IF NOT EXISTS cannot repair constraints on a table left behind
-- by an interrupted/manual partial apply. Re-assert the critical checks so a
-- tracker-missing replay repairs the table instead of merely stamping it.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'planning_import_jobs'::regclass
       AND conname = 'planning_import_jobs_sha256_chk'
  ) THEN
    ALTER TABLE planning_import_jobs
      ADD CONSTRAINT planning_import_jobs_sha256_chk
      CHECK (file_sha256 ~ '^[0-9a-f]{64}$');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'planning_import_jobs'::regclass
       AND conname = 'planning_import_jobs_file_size_chk'
  ) THEN
    ALTER TABLE planning_import_jobs
      ADD CONSTRAINT planning_import_jobs_file_size_chk
      CHECK (file_size_bytes > 0 AND file_size_bytes <= 26214400);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'planning_import_jobs'::regclass
       AND conname = 'planning_import_jobs_status_chk'
  ) THEN
    ALTER TABLE planning_import_jobs
      ADD CONSTRAINT planning_import_jobs_status_chk
      CHECK (status IN ('processing', 'succeeded', 'failed', 'stale'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'planning_import_jobs'::regclass
       AND conname = 'planning_import_jobs_stage_chk'
  ) THEN
    ALTER TABLE planning_import_jobs
      ADD CONSTRAINT planning_import_jobs_stage_chk
      CHECK (stage IN ('accepted', 'extracting', 'validating', 'storing', 'saving', 'complete'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'planning_import_jobs'::regclass
       AND conname = 'planning_import_jobs_terminal_shape_chk'
  ) THEN
    ALTER TABLE planning_import_jobs
      ADD CONSTRAINT planning_import_jobs_terminal_shape_chk
      CHECK (
        (
          status = 'processing'
          AND stage != 'complete'
          AND revision_id IS NULL
          AND completed_at IS NULL
          AND error_code IS NULL
          AND error_message IS NULL
        )
        OR (
          status = 'succeeded'
          AND stage = 'complete'
          AND revision_id IS NOT NULL
          AND completed_at IS NOT NULL
          AND error_code IS NULL
          AND error_message IS NULL
        )
        OR (
          status IN ('failed', 'stale')
          AND stage != 'complete'
          AND revision_id IS NULL
          AND completed_at IS NOT NULL
          AND error_code IS NOT NULL
          AND error_message IS NOT NULL
        )
      );
  END IF;
END;
$$;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "planning_import_jobs_project_started_idx"
  ON "planning_import_jobs" ("project_id", "started_at" DESC);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "planning_import_jobs_active_idx"
  ON "planning_import_jobs" ("project_id", "updated_at")
  WHERE "status" = 'processing';--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "planning_import_jobs_revision_unique"
  ON "planning_import_jobs" ("revision_id")
  WHERE "revision_id" IS NOT NULL;--> statement-breakpoint

CREATE OR REPLACE FUNCTION guard_planning_import_job_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  old_stage_rank integer;
  new_stage_rank integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status != 'processing'
       OR NEW.stage != 'accepted'
       OR NEW.revision_id IS NOT NULL
       OR NEW.completed_at IS NOT NULL
       OR NEW.error_code IS NOT NULL
       OR NEW.error_message IS NOT NULL THEN
      RAISE EXCEPTION 'planning import jobs must begin in accepted processing state'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.project_id != OLD.project_id
     OR NEW.file_name != OLD.file_name
     OR NEW.file_sha256 != OLD.file_sha256
     OR NEW.mime_type != OLD.mime_type
     OR NEW.file_size_bytes != OLD.file_size_bytes
     OR NEW.created_by != OLD.created_by
     OR NEW.started_at != OLD.started_at THEN
    RAISE EXCEPTION 'planning import job identity is immutable'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.status IN ('succeeded', 'failed') THEN
    RAISE EXCEPTION 'terminal planning import job % is immutable', OLD.id
      USING ERRCODE = '23514';
  END IF;

  -- A stale row may be corrected only by a genuinely late successful
  -- completion from the still-running request.
  IF OLD.status = 'stale' AND NEW.status != 'succeeded' THEN
    RAISE EXCEPTION 'stale planning import job % may only transition to succeeded', OLD.id
      USING ERRCODE = '23514';
  END IF;

  IF OLD.status = 'processing'
     AND NEW.status NOT IN ('processing', 'succeeded', 'failed', 'stale') THEN
    RAISE EXCEPTION 'invalid planning import status transition'
      USING ERRCODE = '23514';
  END IF;

  old_stage_rank := CASE OLD.stage
    WHEN 'accepted' THEN 1
    WHEN 'extracting' THEN 2
    WHEN 'validating' THEN 3
    WHEN 'storing' THEN 4
    WHEN 'saving' THEN 5
    WHEN 'complete' THEN 6
  END;
  new_stage_rank := CASE NEW.stage
    WHEN 'accepted' THEN 1
    WHEN 'extracting' THEN 2
    WHEN 'validating' THEN 3
    WHEN 'storing' THEN 4
    WHEN 'saving' THEN 5
    WHEN 'complete' THEN 6
  END;

  IF new_stage_rank < old_stage_rank THEN
    RAISE EXCEPTION 'planning import stage cannot move backwards'
      USING ERRCODE = '23514';
  END IF;

  NEW.updated_at := CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$;--> statement-breakpoint

DROP TRIGGER IF EXISTS planning_import_job_lifecycle_trg ON planning_import_jobs;--> statement-breakpoint
CREATE TRIGGER planning_import_job_lifecycle_trg
  BEFORE INSERT OR UPDATE ON planning_import_jobs
  FOR EACH ROW EXECUTE FUNCTION guard_planning_import_job_lifecycle();--> statement-breakpoint