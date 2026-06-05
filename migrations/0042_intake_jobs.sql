-- Task #230 — Background ingest & auto-routing pipeline.
--
-- Adds the async work queue that drives the intake pipeline. One row per
-- intake document: a process-local sweeper claims `pending` rows (lease →
-- `in_flight`), retries transient failures with backoff, reclaims stale
-- in-flight rows after a crash, and dead-letters after the max attempt
-- count. This mirrors the proven drive_uploads / pennylane_pushes queue
-- machinery rather than inventing a new pattern.
--
-- The user-facing analysis/routing state lives on project_intake_documents
-- (analysis_state / routing_state / extracted_data / promoted_kind /
-- promoted_id) — this table only holds the retry/dead-letter bookkeeping.
--
-- All DDL is idempotent (IF NOT EXISTS) so partial-apply recovery is safe.

CREATE TABLE IF NOT EXISTS intake_jobs (
  id                  serial PRIMARY KEY,
  intake_document_id  integer NOT NULL REFERENCES project_intake_documents(id) ON DELETE CASCADE,
  state               text    NOT NULL DEFAULT 'pending',
  attempts            integer NOT NULL DEFAULT 0,
  last_error          text,
  last_attempt_at     timestamp,
  next_attempt_at     timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at          timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- One queue row per intake document — enqueue is idempotent via
-- ON CONFLICT DO NOTHING against this constraint.
CREATE UNIQUE INDEX IF NOT EXISTS intake_jobs_doc_unique
  ON intake_jobs (intake_document_id);

-- Sweeper hot path: list `pending` rows whose next_attempt_at has elapsed.
CREATE INDEX IF NOT EXISTS intake_jobs_state_next_idx
  ON intake_jobs (state, next_attempt_at);

-- Backfill: enqueue a job for every intake document still parked in the
-- `pending` analysis state on deploy, so the pipeline picks up the rows
-- that Task #229 created before this queue existed. Guarded by NOT EXISTS
-- + the unique index so re-running is a no-op.
INSERT INTO intake_jobs (intake_document_id, state, attempts, next_attempt_at, created_at, updated_at)
SELECT pid.id, 'pending', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM project_intake_documents pid
WHERE pid.analysis_state = 'pending'
  AND NOT EXISTS (
    SELECT 1 FROM intake_jobs ij WHERE ij.intake_document_id = pid.id
  );
