-- Task #206 (review fix) — durable async retry for signed-PDF persist.
--
-- The `envelope.signed` webhook fires persistSignedDevisPdf in a
-- detached task to keep the response within Archisign's 5s SLA. If
-- that detached task fails (snapshot URL stale + Archisign 5xx,
-- object-storage outage, server crash mid-attempt), Archisign does
-- NOT redeliver `envelope.signed`, so without a retry queue the audit
-- copy is permanently lost.
--
-- We add three nullable columns to `devis` rather than a separate
-- table because the work item is 1-to-1 with the row and dies with
-- it. The sweeper claims rows where:
--   stage = client_signed_off
--   archisign_envelope_id IS NOT NULL
--   signed_pdf_storage_key IS NULL
--   signed_pdf_retry_attempts < 5
--   signed_pdf_next_attempt_at IS NOT NULL AND signed_pdf_next_attempt_at <= NOW()
--
-- NULL `signed_pdf_next_attempt_at` is TERMINAL (retention breach gave
-- up, or no retry currently scheduled). The webhook handler arms
-- next_attempt_at = NOW()+60s before detaching the first attempt, so
-- a process crash before that attempt completes still leaves the row
-- recoverable by the sweeper.
-- and re-runs the existing idempotent persistSignedDevisPdf().

ALTER TABLE devis
  ADD COLUMN IF NOT EXISTS signed_pdf_retry_attempts integer NOT NULL DEFAULT 0;

ALTER TABLE devis
  ADD COLUMN IF NOT EXISTS signed_pdf_next_attempt_at timestamptz;

ALTER TABLE devis
  ADD COLUMN IF NOT EXISTS signed_pdf_last_error text;

-- Partial index: only the small set of devis that are signed but
-- missing their audit copy participates in the sweep query.
CREATE INDEX IF NOT EXISTS devis_signed_pdf_retry_idx
  ON devis (signed_pdf_next_attempt_at)
  WHERE signed_pdf_storage_key IS NULL
    AND archisign_envelope_id IS NOT NULL;
