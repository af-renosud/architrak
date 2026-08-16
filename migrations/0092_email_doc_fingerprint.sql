-- Task #531 — email intake noise reduction: content fingerprint dedupe.
--
-- The same PDF often arrives through several emails (contractor copy,
-- Docusign copy, help@ forward). Capture now fingerprints attachment bytes
-- (sha256) and, when the fingerprint already exists, records the new email
-- as an additional source on the existing document instead of creating a
-- new row.
--   - content_fingerprint: sha256 hex of the attachment bytes (nullable —
--     historical rows have none and are never backfilled).
--   - additional_sources: jsonb array of {emailMessageId, emailFrom,
--     emailSubject, emailReceivedAt, emailLink} entries for later copies.
ALTER TABLE "email_documents"
  ADD COLUMN "content_fingerprint" text;

ALTER TABLE "email_documents"
  ADD COLUMN "additional_sources" jsonb;

-- UNIQUE so two concurrent pollers cannot both insert the same bytes; the
-- capture path turns the losing insert into an additional-source append.
CREATE UNIQUE INDEX "email_documents_content_fingerprint_idx"
  ON "email_documents" ("content_fingerprint")
  WHERE "content_fingerprint" IS NOT NULL;
