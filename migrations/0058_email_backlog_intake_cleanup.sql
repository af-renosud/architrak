-- Task #322 (part 2) — the backlog dump (0057) marked queued email docs
-- 'skipped', but some of them had already been assigned a project and
-- therefore mirrored into project_intake_documents (with an intake_jobs
-- queue row). Those mirrors would still be analyzed/routed by the intake
-- sweeper, defeating the reset. Clean them up:
--
-- 1. Tombstone every skipped email doc (intake_deleted_at) so no future
--    update can recreate its mirror (mirror code honors the tombstone).
-- 2. Delete un-routed mirrors sourced from skipped docs; their intake_jobs
--    rows cascade via FK, so no queued or retrying work survives. Mirrors
--    already routed into a promoted record are left alone — that work is
--    done and deleting them would orphan the promoted draft.
--
-- Idempotent: both statements are no-ops on re-run.
UPDATE "email_documents"
SET "intake_deleted_at" = CURRENT_TIMESTAMP,
    "updated_at" = CURRENT_TIMESTAMP
WHERE "extraction_status" = 'skipped'
  AND "intake_deleted_at" IS NULL;
--> statement-breakpoint
DELETE FROM "project_intake_documents" p
USING "email_documents" e
WHERE p."source_email_document_id" = e."id"
  AND e."extraction_status" = 'skipped'
  AND p."routing_state" <> 'routed'
  AND p."promoted_id" IS NULL;
