-- Task #198 — broaden the drive_uploads doc_kind allow-list to include
-- gmail-scraped project_documents that aren't yet promoted into a
-- devis/facture row. See server/gmail/document-parser.ts.
ALTER TABLE drive_uploads DROP CONSTRAINT IF EXISTS drive_uploads_doc_kind_check;
ALTER TABLE drive_uploads
  ADD CONSTRAINT drive_uploads_doc_kind_check
  CHECK (doc_kind IN ('devis','invoice','certificat','scrape'));
