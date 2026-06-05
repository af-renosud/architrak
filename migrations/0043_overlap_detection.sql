-- Task #231 — Overlap & supersession detection engine.
--
-- A per-project background reconciliation pass detects dangerous document
-- relationships (above all a consolidated devis that has absorbed earlier
-- individual devis = silent double-counting). It is layered: semantic
-- candidate matching (Gemini embeddings + pgvector) → deterministic
-- subset-sum screening → Gemini reasoning with citations → arithmetic
-- proof + verdict → idempotent "overlap cases". It changes NO financial
-- total and fires NO user-facing alert (those are downstream tasks).
--
-- pgvector is NEW to this schema — the extension is created here. The
-- queue (reconciliation_jobs) mirrors the proven intake_jobs /
-- drive_uploads machinery. All DDL is idempotent (IF NOT EXISTS) so
-- partial-apply recovery is safe.

-- pgvector: required for the document_embeddings.embedding column below.
CREATE EXTENSION IF NOT EXISTS vector;

-- One cached embedding per devis. Regenerated only when content_hash
-- changes, so re-runs never re-call the embedding model for unchanged
-- documents. embedding is vector(768) to match Gemini text-embedding-004.
CREATE TABLE IF NOT EXISTS document_embeddings (
  id            serial PRIMARY KEY,
  project_id    integer     NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  devis_id      integer     NOT NULL REFERENCES devis(id) ON DELETE CASCADE,
  content_hash  text        NOT NULL,
  model         text        NOT NULL,
  embedding     vector(768) NOT NULL,
  created_at    timestamp   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    timestamp   NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS document_embeddings_devis_unique
  ON document_embeddings (devis_id);
CREATE INDEX IF NOT EXISTS document_embeddings_project_idx
  ON document_embeddings (project_id);

-- Detected cases. case_key is a stable identity hash of
-- (project, relationship, primary devis, sorted member devis) so re-runs
-- upsert rather than duplicate. citations carry NO banking/sensitive
-- fields. status follows active → withdrawn (append-only; never deleted).
CREATE TABLE IF NOT EXISTS overlap_cases (
  id                serial PRIMARY KEY,
  project_id        integer       NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  case_key          text          NOT NULL,
  relationship_type text          NOT NULL,
  primary_devis_id  integer       NOT NULL REFERENCES devis(id) ON DELETE CASCADE,
  member_devis_ids  jsonb         NOT NULL,
  detection_source  text          NOT NULL,
  confidence        numeric(4,3)  NOT NULL,
  verdict           text          NOT NULL,
  arithmetic_proof  jsonb,
  citations         jsonb         NOT NULL,
  reasoning         text,
  status            text          NOT NULL DEFAULT 'active',
  last_seen_at      timestamp     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  withdrawn_at      timestamp,
  created_at        timestamp     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        timestamp     NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS overlap_cases_key_unique
  ON overlap_cases (case_key);
CREATE INDEX IF NOT EXISTS overlap_cases_project_idx
  ON overlap_cases (project_id);
CREATE INDEX IF NOT EXISTS overlap_cases_project_status_idx
  ON overlap_cases (project_id, status);
CREATE INDEX IF NOT EXISTS overlap_cases_primary_devis_idx
  ON overlap_cases (primary_devis_id);

-- Per-project reconciliation work queue. One row per project (UNIQUE) so
-- multiple document arrivals coalesce into a single pending run. Mirrors
-- intake_jobs: claim (lease → in_flight), backoff, reclaim stale, dead-letter.
CREATE TABLE IF NOT EXISTS reconciliation_jobs (
  id              serial PRIMARY KEY,
  project_id      integer   NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  state           text      NOT NULL DEFAULT 'pending',
  attempts        integer   NOT NULL DEFAULT 0,
  last_error      text,
  last_attempt_at timestamp,
  next_attempt_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at      timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS reconciliation_jobs_project_unique
  ON reconciliation_jobs (project_id);
CREATE INDEX IF NOT EXISTS reconciliation_jobs_state_next_idx
  ON reconciliation_jobs (state, next_attempt_at);
