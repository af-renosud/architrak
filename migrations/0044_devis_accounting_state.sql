-- Task #232 — Provisional accounting state & Contracted guard.
--
-- Adds an explicit accounting state to every devis so the Contracted /
-- Certified / Reste-à-Réaliser buckets count only genuinely-active devis.
--   provisional — freshly ingested (PDF upload / intake); NOT yet counted.
--   active      — genuinely contracted; counts toward the buckets.
--   superseded  — folded into another devis (arithmetic proof or a recorded
--                 human decision); removed from the buckets.
--
-- Existing rows backfill to `active` (DEFAULT) so behaviour is unchanged for
-- everything that predates this column — only freshly-ingested devis start
-- `provisional` (set in the application layer, not here). A devis NEVER leaves
-- Contracted silently: accounting_state_changes is the append-only audit of
-- every transition, mirroring the document_advisories / overlap_cases pattern.
--
-- All DDL is idempotent (IF NOT EXISTS) so partial-apply recovery is safe.

ALTER TABLE devis
  ADD COLUMN IF NOT EXISTS accounting_state text NOT NULL DEFAULT 'active';

CREATE TABLE IF NOT EXISTS accounting_state_changes (
  id              serial    PRIMARY KEY,
  devis_id        integer   NOT NULL REFERENCES devis(id) ON DELETE CASCADE,
  project_id      integer   NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  from_state      text      NOT NULL,
  to_state        text      NOT NULL,
  reason          text      NOT NULL,
  overlap_case_id integer   REFERENCES overlap_cases(id) ON DELETE SET NULL,
  actor_user_id   integer   REFERENCES users(id) ON DELETE SET NULL,
  note            text,
  created_at      timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS accounting_state_changes_devis_idx
  ON accounting_state_changes (devis_id);
CREATE INDEX IF NOT EXISTS accounting_state_changes_project_idx
  ON accounting_state_changes (project_id);
CREATE INDEX IF NOT EXISTS accounting_state_changes_case_idx
  ON accounting_state_changes (overlap_case_id);
