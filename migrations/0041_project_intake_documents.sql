-- Task #229 — Unified document intake front door.
--
-- Today the team must pre-classify a financial document before uploading it
-- (devis go through the Devis tab, factures through the Factures tab, anything
-- else through the project document uploader). The firm director wants a single
-- "Upload document" action at project level: the team just uploads the file and
-- the system sorts it later.
--
-- This migration adds the holding area that backs that front door:
-- `project_intake_documents`. Every uploaded file — manual upload OR an email
-- attachment that has been matched to a project — lands here in a `pending`
-- analysis state. The AI classification / extraction / routing into typed
-- records is a LATER task; here the row is just parked.
--
-- Columns deliberately kept flexible:
--   * analysis_state / routing_state are plain status strings (no enum/check)
--     so downstream tasks can extend the vocabulary without a migration.
--   * content_fingerprint is a placeholder for the later dedup step (NULL now).
--   * extracted_data (jsonb) is the slot the AI step will fill.
--   * promoted_kind / promoted_id record which typed record (devis, invoice, …)
--     an intake item is eventually promoted into.
--   * source_email_document_id points back to the `email_documents` provenance
--     row for email-sourced items (one intake row per email document, enforced
--     by the partial unique index below).
--
-- All DDL is idempotent (IF NOT EXISTS) so partial-apply recovery is safe.

CREATE TABLE IF NOT EXISTS project_intake_documents (
  id                       serial PRIMARY KEY,
  project_id               integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  file_name                text    NOT NULL,
  storage_key              text    NOT NULL,
  mime_type                text,
  file_size                integer,
  source                   text    NOT NULL DEFAULT 'manual',
  content_fingerprint      text,
  analysis_state           text    NOT NULL DEFAULT 'pending',
  routing_state            text    NOT NULL DEFAULT 'unrouted',
  extracted_data           jsonb,
  source_email_document_id integer REFERENCES email_documents(id),
  promoted_kind            text,
  promoted_id              integer,
  uploaded_by              text,
  notes                    text,
  created_at               timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at               timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS project_intake_documents_project_id_idx
  ON project_intake_documents (project_id);

CREATE INDEX IF NOT EXISTS project_intake_documents_analysis_state_idx
  ON project_intake_documents (analysis_state);

-- One intake row per email document. Partial unique index (NULLs allowed,
-- unbounded) so manual uploads — which have a NULL source_email_document_id —
-- are never constrained, while the email-mirror path can safely upsert with
-- ON CONFLICT DO NOTHING.
CREATE UNIQUE INDEX IF NOT EXISTS project_intake_documents_source_email_doc_idx
  ON project_intake_documents (source_email_document_id)
  WHERE source_email_document_id IS NOT NULL;

-- One-time backfill: surface every email attachment already matched to a
-- project so the unified per-project intake list is complete immediately on
-- deploy (not just for documents that happen to be re-touched afterwards).
-- Forward-path mirroring is handled in application code. Guarded by NOT EXISTS
-- + the unique index so re-running this migration is a no-op.
INSERT INTO project_intake_documents
  (project_id, file_name, storage_key, mime_type, source,
   analysis_state, routing_state, source_email_document_id, created_at, updated_at)
SELECT
  ed.project_id,
  COALESCE(ed.attachment_file_name, 'document.pdf'),
  ed.storage_key,
  'application/pdf',
  'gmail',
  'pending',
  'unrouted',
  ed.id,
  ed.created_at,
  ed.updated_at
FROM email_documents ed
WHERE ed.project_id IS NOT NULL
  AND ed.storage_key IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM project_intake_documents pid
    WHERE pid.source_email_document_id = ed.id
  );
