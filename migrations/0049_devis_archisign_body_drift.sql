-- Task #283 — persist the Archisign §3.5.1.1 BODY-rendering drift signal.
-- Since the v1.2 amendment entered force (2026-07-13, RENDERED election
-- countersigned 2026-07-12), Archisign MUST render the architect's note
-- under "Message from the sender:" in the signer-invitation email. A
-- `bodyApplied: false` echo on /envelopes/create for a body we sent now
-- means the note silently vanished from the signer email — a contract
-- breach, mirrored from the subject-drift path (0048).
--
-- Set when /envelopes/create echoes `emailRendering.bodyApplied=false`
-- for a non-empty body we sent; cleared (NULL) on each fresh create whose
-- echo does not report body drift. NULL for all existing rows.

ALTER TABLE devis
  ADD COLUMN IF NOT EXISTS archisign_body_drift_at timestamptz;
