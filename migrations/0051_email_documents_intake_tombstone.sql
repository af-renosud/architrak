-- Tombstone for intentionally-deleted gmail-mirrored intake documents.
-- Without it, any later update to the email_documents row re-triggers
-- mirrorEmailDocumentToIntake and silently resurrects the deleted intake doc.
ALTER TABLE "email_documents" ADD COLUMN IF NOT EXISTS "intake_deleted_at" timestamp;
