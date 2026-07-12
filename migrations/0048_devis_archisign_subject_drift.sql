-- Task #279 — persist the Archisign §3.5.1.1(c) subject-rendering drift
-- signal so it survives restarts and can be surfaced in the operator UI
-- (SigningPanel warning + /admin/ops/archisign-rendering-drift), instead
-- of living only in server stdout.
--
-- Set when /envelopes/create echoes `emailRendering.subjectApplied=false`
-- for a subject we sent; cleared (NULL) on each fresh create whose echo
-- does not report drift. NULL for all existing rows — the echo is a
-- proposed v1.2 amendment and has never been consumed persistently before.

ALTER TABLE devis
  ADD COLUMN IF NOT EXISTS archisign_subject_drift_at timestamptz;
