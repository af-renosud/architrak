-- Task #206 — persist signed devis PDF locally + mirror to per-lot Drive folder.
--
-- Adds a single nullable column on `devis` that holds the object-storage
-- key of the signed PDF downloaded from Archisign immediately after the
-- `envelope.signed` webhook. Population is one-shot (idempotent on the
-- column being non-null) and never rolled back — once persisted the
-- audit copy stays even if the source row's stage is later corrected.
--
-- Also extends the `drive_uploads.doc_kind` allow-list with a new
-- `devis_signed` value so the existing AT5-style upload queue can
-- mirror the signed PDF into the same per-lot folder as the original
-- devis (`{Lot} {project} {devisCode}`), tagged with a "signed_" file
-- name prefix to keep it visually adjacent to the original. Drive
-- writeback for this kind targets no source-row column — the audit
-- pointer lives on the drive_uploads row itself, mirroring the
-- existing `scrape` precedent.

ALTER TABLE devis
  ADD COLUMN IF NOT EXISTS signed_pdf_storage_key text;

ALTER TABLE drive_uploads DROP CONSTRAINT IF EXISTS drive_uploads_doc_kind_check;
ALTER TABLE drive_uploads
  ADD CONSTRAINT drive_uploads_doc_kind_check
  CHECK (doc_kind IN ('devis','invoice','certificat','scrape','devis_signed'));
