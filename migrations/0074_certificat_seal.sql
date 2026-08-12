-- Task #451 — Certificat issuance seal + certificat_sources junction.
--
-- 1) Seal columns on certificats: a certificat is a payment instruction, so
--    on explicit issue/send we render ONCE, pin the exact PDF bytes
--    (pdf_storage_key) and freeze the financial inputs (issuance_snapshot,
--    issued_at). NULL pdf_storage_key ⇔ draft/preview-only. The seal is
--    written via a conditional UPDATE (WHERE pdf_storage_key IS NULL) so
--    concurrent sends elect exactly one sealer.
--
-- 2) certificat_sources: FK-grounded record of which situation(s)/invoice(s)
--    a sealed certificat certifies — replaces the loose free-text
--    invoices.certificate_number, which is dropped here. That column was
--    never written by any server path (always initialised NULL), so the drop
--    loses no data in practice; any manually entered value is superseded by
--    the junction going forward.

ALTER TABLE "certificats" ADD COLUMN IF NOT EXISTS "pdf_storage_key" text;
ALTER TABLE "certificats" ADD COLUMN IF NOT EXISTS "pdf_file_name" text;
ALTER TABLE "certificats" ADD COLUMN IF NOT EXISTS "issued_at" timestamp;
ALTER TABLE "certificats" ADD COLUMN IF NOT EXISTS "issuance_snapshot" jsonb;

CREATE TABLE IF NOT EXISTS "certificat_sources" (
  "id" serial PRIMARY KEY NOT NULL,
  "certificat_id" integer NOT NULL,
  "situation_id" integer,
  "invoice_id" integer,
  "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  CONSTRAINT "certificat_sources_certificat_id_certificats_id_fk"
    FOREIGN KEY ("certificat_id") REFERENCES "certificats"("id") ON DELETE cascade,
  CONSTRAINT "certificat_sources_situation_id_situations_id_fk"
    FOREIGN KEY ("situation_id") REFERENCES "situations"("id") ON DELETE cascade,
  CONSTRAINT "certificat_sources_invoice_id_invoices_id_fk"
    FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE cascade,
  CONSTRAINT "certificat_sources_exactly_one_target"
    CHECK (("situation_id" IS NOT NULL) <> ("invoice_id" IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS "certificat_sources_certificat_id_idx" ON "certificat_sources" ("certificat_id");
CREATE INDEX IF NOT EXISTS "certificat_sources_situation_id_idx" ON "certificat_sources" ("situation_id");
CREATE INDEX IF NOT EXISTS "certificat_sources_invoice_id_idx" ON "certificat_sources" ("invoice_id");
CREATE UNIQUE INDEX IF NOT EXISTS "certificat_sources_cert_situation_unique"
  ON "certificat_sources" ("certificat_id", "situation_id") WHERE "situation_id" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "certificat_sources_cert_invoice_unique"
  ON "certificat_sources" ("certificat_id", "invoice_id") WHERE "invoice_id" IS NOT NULL;

ALTER TABLE "invoices" DROP COLUMN IF EXISTS "certificate_number";
