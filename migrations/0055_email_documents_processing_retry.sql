-- Task #310 — automatic processing of captured email documents.
-- Retry bookkeeping for the background email-document processor:
-- processing_attempts counts extraction attempts; next_process_attempt_at
-- gates retry backoff (NULL = due immediately). Server-authoritative —
-- deliberately excluded from insertEmailDocumentSchema so the generic
-- PATCH route cannot manipulate retry state.
ALTER TABLE "email_documents" ADD COLUMN IF NOT EXISTS "processing_attempts" integer NOT NULL DEFAULT 0;
ALTER TABLE "email_documents" ADD COLUMN IF NOT EXISTS "next_process_attempt_at" timestamp;
