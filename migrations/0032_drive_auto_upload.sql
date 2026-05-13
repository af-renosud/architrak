-- Task #198: Auto-create Drive folders for devis & uploads.
--
-- Adds the schema needed to push every financial document for a lot
-- (devis, factures, certificats — credit notes too once the table
-- exists) into a single per-lot folder on the Renosud shared Google
-- Drive, located at:
--   {client folder matching project name} / FINANCIAL /
--   LIVE PROJECT FINANCIAL / 1 DEVIS & FACTURE FOLDERS /
--   {Lot} {project_name} {devisCode}
--
-- Two kinds of additions:
--   (a) Per-row caches so we never have to walk the Drive tree twice
--       for the same project / lot / document.
--   (b) A `drive_uploads` queue table that powers the AT5-style retry
--       orchestrator + admin DLQ. Drive uploads are intentionally
--       out-of-band so a slow/down Drive never blocks devis ingestion.
--
-- Everything is idempotent (IF NOT EXISTS) so partial-apply recovery
-- mirrors the rest of the migration set.

-- ---------------------------------------------------------------------
-- (a) Per-row cache columns. All nullable — the column being null means
-- "not yet resolved / not yet uploaded".
-- ---------------------------------------------------------------------

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS drive_folder_id text;

ALTER TABLE lots
  ADD COLUMN IF NOT EXISTS drive_folder_id text;

ALTER TABLE devis
  ADD COLUMN IF NOT EXISTS drive_file_id text,
  ADD COLUMN IF NOT EXISTS drive_web_view_link text,
  ADD COLUMN IF NOT EXISTS drive_uploaded_at timestamp;

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS drive_file_id text,
  ADD COLUMN IF NOT EXISTS drive_web_view_link text,
  ADD COLUMN IF NOT EXISTS drive_uploaded_at timestamp;

ALTER TABLE certificats
  ADD COLUMN IF NOT EXISTS drive_file_id text,
  ADD COLUMN IF NOT EXISTS drive_web_view_link text,
  ADD COLUMN IF NOT EXISTS drive_uploaded_at timestamp;

-- ---------------------------------------------------------------------
-- (b) Outbound upload queue. One row per (doc_kind, doc_id) — re-enqueue
-- of an already-completed row is a no-op (handled in the service).
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS drive_uploads (
  id                    serial PRIMARY KEY,
  -- Source document the upload represents. doc_id is intentionally a
  -- plain integer (not a FK) because doc_kind selects which table it
  -- points at and Postgres has no polymorphic FK. The application
  -- enforces existence at enqueue time.
  doc_kind              text NOT NULL,
  doc_id                integer NOT NULL,
  -- Routing inputs the worker uses to resolve / cache the lot folder.
  project_id            integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  lot_id                integer REFERENCES lots(id) ON DELETE SET NULL,
  source_storage_key    text NOT NULL,
  display_name          text NOT NULL,
  -- State machine: pending → in_flight → succeeded | failed | dead_letter
  state                 text NOT NULL DEFAULT 'pending',
  attempts              integer NOT NULL DEFAULT 0,
  last_error            text,
  last_attempt_at       timestamp,
  next_attempt_at       timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Populated on success — also written back to the doc_kind row.
  drive_file_id         text,
  drive_web_view_link   text,
  created_at            timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT drive_uploads_doc_kind_check CHECK (doc_kind IN ('devis','invoice','certificat')),
  CONSTRAINT drive_uploads_state_check    CHECK (state IN ('pending','in_flight','succeeded','failed','dead_letter')),
  CONSTRAINT drive_uploads_doc_unique     UNIQUE (doc_kind, doc_id)
);

CREATE INDEX IF NOT EXISTS drive_uploads_state_next_idx
  ON drive_uploads (state, next_attempt_at);

CREATE INDEX IF NOT EXISTS drive_uploads_project_idx
  ON drive_uploads (project_id);
