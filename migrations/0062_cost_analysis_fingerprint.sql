-- Task #381 — staleness detection for confirmed cost analyses.
--
-- Stores a SHA-256 fingerprint of the quotation data (line items + header
-- amounts + lot) the analysis was generated from. When the devis lines or
-- amounts change afterwards, the current fingerprint no longer matches and
-- the UI warns the architect to regenerate before sending. NULL for
-- analyses generated before this column existed (staleness unknown — no
-- warning shown).
ALTER TABLE "devis_cost_analyses" ADD COLUMN "quotation_fingerprint" text;
