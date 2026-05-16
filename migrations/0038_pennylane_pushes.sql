-- Task #214 — Pennylane accounting integration.
--
-- Two kinds of additions:
--   (a) Per-row mirror caches so the queue worker has somewhere to
--       record the Pennylane-side ids it learns and the paid-status
--       poller has somewhere to write back the live state.
--   (b) A `pennylane_pushes` queue table that powers the AT5-style
--       retry orchestrator + admin DLQ. Modelled on drive_uploads
--       (migration 0032) so the operational shape is the same.
--
-- Scope reminder (re-confirmed with the user 2026-05-16): ONLY the
-- architect-honoraires customer_invoice direction is pushed.
-- Contractor / supplier data NEVER leaves ArchiTrak — the architect
-- firm is not the contractor's customer or supplier in their books.
--
-- Everything is idempotent (IF NOT EXISTS) so partial-apply recovery
-- mirrors the rest of the migration set.

-- ---------------------------------------------------------------------
-- (a) Per-row mirror columns.
--
-- projects.pennylane_customer_id: lazily resolved on first push for the
--   project (idempotent on external_id="architrak:client:project:{id}").
-- fee_entries.pennylane_invoice_id: API-assigned customer_invoice id.
--   UNIQUE-WHERE-NOT-NULL so a duplicate write would fail loudly
--   rather than silently re-link two local fee entries to one remote.
-- fee_entries.pennylane_pdf_storage_key: object-storage key for the
--   PDF we mirrored from Pennylane's short-lived public_file_url. Used
--   both for the audit trail and as the email attachment source.
-- fee_entries.pennylane_pushed_at: first-time push timestamp; never
--   updated by subsequent paid-status polls.
-- fee_entries.pennylane_paid_at + _paid_amount + _status: written by
--   the hourly paid-status poller from GET /customer_invoices.
-- ---------------------------------------------------------------------

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS pennylane_customer_id text;

ALTER TABLE fee_entries
  ADD COLUMN IF NOT EXISTS pennylane_invoice_id      text,
  ADD COLUMN IF NOT EXISTS pennylane_pdf_storage_key text,
  ADD COLUMN IF NOT EXISTS pennylane_pushed_at       timestamp,
  ADD COLUMN IF NOT EXISTS pennylane_paid_at         timestamp,
  ADD COLUMN IF NOT EXISTS pennylane_paid_amount     numeric(12, 2),
  ADD COLUMN IF NOT EXISTS pennylane_status          text;

CREATE UNIQUE INDEX IF NOT EXISTS fee_entries_pennylane_invoice_unique
  ON fee_entries (pennylane_invoice_id)
  WHERE pennylane_invoice_id IS NOT NULL;

-- ---------------------------------------------------------------------
-- (b) Outbound push queue. ONE row per (kind, doc_id) — re-enqueue of
-- an already-succeeded row is a no-op (handled in the service layer
-- via the unique constraint).
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS pennylane_pushes (
  id              serial PRIMARY KEY,
  -- kind: one of customer | customer_invoice | email_send.
  -- doc_id: kind=customer    → projects.id
  --         kind=customer_invoice → fee_entries.id
  --         kind=email_send  → fee_entries.id
  -- doc_id is intentionally a plain integer (no FK) — kind selects
  -- the target table and Postgres has no polymorphic FK. The
  -- application enforces existence at enqueue time.
  kind            text    NOT NULL,
  doc_id          integer NOT NULL,
  project_id      integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- State machine: pending → in_flight → succeeded | failed | dead_letter
  state           text    NOT NULL DEFAULT 'pending',
  attempts        integer NOT NULL DEFAULT 0,
  last_error      text,
  last_attempt_at timestamp,
  next_attempt_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Pennylane-assigned id on success. For `customer` kind: the
  -- customer id; for `customer_invoice` kind: the invoice id; for
  -- `email_send` kind: the Gmail message id. Stored as text — the
  -- API returns ints for some and strings for others.
  pennylane_id    text,
  -- True when this row was created under PENNYLANE_DRY_RUN.
  dry_run         boolean NOT NULL DEFAULT false,
  created_at      timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT pennylane_pushes_kind_check  CHECK (kind IN ('customer','customer_invoice','email_send')),
  CONSTRAINT pennylane_pushes_state_check CHECK (state IN ('pending','in_flight','succeeded','failed','dead_letter')),
  CONSTRAINT pennylane_pushes_doc_unique  UNIQUE (kind, doc_id)
);

CREATE INDEX IF NOT EXISTS pennylane_pushes_state_next_idx
  ON pennylane_pushes (state, next_attempt_at);

CREATE INDEX IF NOT EXISTS pennylane_pushes_project_idx
  ON pennylane_pushes (project_id);
