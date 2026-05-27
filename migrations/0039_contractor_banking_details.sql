-- Task #225 — Contractor banking details on certificats de paiement.
--
-- ArchiDoc now carries the contractor IBAN/BIC and the supporting RIB
-- document. We mirror those 9 fields on `archidoc_contractors` (read
-- model populated by the contractor sync) and promote them onto the
-- local `contractors` table (the row the certificat generator reads).
--
-- We ALSO learn the IBAN/BIC printed on incoming devis / factures from
-- the Gemini parser and store them on the documents themselves. If the
-- extracted value disagrees with the one ArchiDoc has on file, the
-- certificat generator refuses to issue payment until an architect
-- records an explicit override row in `banking_mismatch_overrides`
-- (anti-fraud gate).
--
-- All additions are idempotent (IF NOT EXISTS / per-column ALTER) so
-- partial-apply recovery is safe.

-- ---------------------------------------------------------------------
-- (a) Banking fields on the local `contractors` row that the certificat
-- generator reads. Lengths chosen to fit the formal ISO/IEC limits
-- (IBAN 15..34, BIC 8 or 11). banking_verified_* are written by the
-- ArchiDoc verifier UI and faithfully mirrored here.
-- ---------------------------------------------------------------------

ALTER TABLE contractors
  ADD COLUMN IF NOT EXISTS account_holder_name        varchar(255),
  ADD COLUMN IF NOT EXISTS iban                       varchar(34),
  ADD COLUMN IF NOT EXISTS bic                        varchar(11),
  ADD COLUMN IF NOT EXISTS bank_name                  varchar(255),
  ADD COLUMN IF NOT EXISTS rib_document_url           text,
  ADD COLUMN IF NOT EXISTS rib_document_name          varchar(255),
  ADD COLUMN IF NOT EXISTS banking_verified_at        timestamp,
  ADD COLUMN IF NOT EXISTS banking_verified_by        text,
  ADD COLUMN IF NOT EXISTS banking_ai_extracted_data  jsonb;

-- ---------------------------------------------------------------------
-- (b) Same 9 fields on the ArchiDoc mirror so the sync upsert has a
-- 1:1 destination per upstream row (no synthesised columns).
-- ---------------------------------------------------------------------

ALTER TABLE archidoc_contractors
  ADD COLUMN IF NOT EXISTS account_holder_name        varchar(255),
  ADD COLUMN IF NOT EXISTS iban                       varchar(34),
  ADD COLUMN IF NOT EXISTS bic                        varchar(11),
  ADD COLUMN IF NOT EXISTS bank_name                  varchar(255),
  ADD COLUMN IF NOT EXISTS rib_document_url           text,
  ADD COLUMN IF NOT EXISTS rib_document_name          varchar(255),
  ADD COLUMN IF NOT EXISTS banking_verified_at        timestamp,
  ADD COLUMN IF NOT EXISTS banking_verified_by        text,
  ADD COLUMN IF NOT EXISTS banking_ai_extracted_data  jsonb;

-- ---------------------------------------------------------------------
-- (c) Gemini-extracted IBAN/BIC on incoming supplier docs. NULL when
-- not stated on the document; not an extraction failure. Compared to
-- `contractors.iban` at certificat-issue time.
-- ---------------------------------------------------------------------

ALTER TABLE devis
  ADD COLUMN IF NOT EXISTS extracted_iban varchar(34),
  ADD COLUMN IF NOT EXISTS extracted_bic  varchar(11);

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS extracted_iban varchar(34),
  ADD COLUMN IF NOT EXISTS extracted_bic  varchar(11);

-- ---------------------------------------------------------------------
-- (d) Anti-fraud override audit. Architect-only: every override row
-- pairs the document-side IBAN (what the supplier printed) with the
-- ArchiDoc-side IBAN (what we'll actually pay), the architect who
-- accepted the discrepancy, and their reason. The certificat generator
-- treats a non-NULL match-or-override as "cleared".
--
-- doc_kind/doc_id are intentionally polymorphic (no FK) because Postgres
-- has no polymorphic FK and we don't want a partial-index zoo. The
-- application enforces existence at insert time.
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS banking_mismatch_overrides (
  id                  serial PRIMARY KEY,
  doc_kind            text    NOT NULL,
  doc_id              integer NOT NULL,
  contractor_id       integer NOT NULL REFERENCES contractors(id) ON DELETE CASCADE,
  doc_iban            text    NOT NULL,
  archidoc_iban       text    NOT NULL,
  override_by_user_id integer REFERENCES users(id) ON DELETE SET NULL,
  reason              text    NOT NULL,
  created_at          timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT banking_mismatch_overrides_doc_kind_check
    CHECK (doc_kind IN ('devis', 'invoice')),
  CONSTRAINT banking_mismatch_overrides_doc_unique
    UNIQUE (doc_kind, doc_id, doc_iban, archidoc_iban)
);

CREATE INDEX IF NOT EXISTS banking_mismatch_overrides_contractor_idx
  ON banking_mismatch_overrides (contractor_id);

CREATE INDEX IF NOT EXISTS banking_mismatch_overrides_doc_idx
  ON banking_mismatch_overrides (doc_kind, doc_id);
