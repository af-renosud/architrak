-- Immutable application of an opening deposit against the exact gross invoice
-- that prints the deduction. This preserves gross documentary figures while
-- preventing the same deposit from also being added to Certified.
CREATE TABLE IF NOT EXISTS "invoice_acompte_applications" (
  "id" serial PRIMARY KEY NOT NULL,
  "invoice_id" integer NOT NULL,
  "devis_id" integer NOT NULL,
  "certificat_id" integer NOT NULL,
  "source_intake_document_id" integer NOT NULL,
  "no_invoice_payment_id" integer,
  "source_storage_key" text NOT NULL,
  "source_file_name" text NOT NULL,
  "source_content_fingerprint" text NOT NULL,
  "applied_ht" numeric(12, 2) NOT NULL,
  "applied_ttc" numeric(12, 2) NOT NULL,
  "invoice_gross_ht" numeric(12, 2) NOT NULL,
  "invoice_gross_ttc" numeric(12, 2) NOT NULL,
  "invoice_net_payable_ttc" numeric(12, 2) NOT NULL,
  "payment_ledger_paid_at" date,
  "payment_audit_paid_at" timestamp with time zone,
  "payment_ledger_references" text,
  "payment_audit_reference" text,
  "payment_conflict" boolean DEFAULT false NOT NULL,
  "evidence_text" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
  CONSTRAINT "invoice_acompte_applications_invoice_fk" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE RESTRICT,
  CONSTRAINT "invoice_acompte_applications_devis_fk" FOREIGN KEY ("devis_id") REFERENCES "devis"("id") ON DELETE RESTRICT,
  CONSTRAINT "invoice_acompte_applications_certificat_fk" FOREIGN KEY ("certificat_id") REFERENCES "certificats"("id") ON DELETE RESTRICT,
  CONSTRAINT "invoice_acompte_applications_source_fk" FOREIGN KEY ("source_intake_document_id") REFERENCES "project_intake_documents"("id") ON DELETE RESTRICT,
  CONSTRAINT "invoice_acompte_applications_no_invoice_payment_fk" FOREIGN KEY ("no_invoice_payment_id") REFERENCES "acompte_no_invoice_payments"("id") ON DELETE RESTRICT,
  CONSTRAINT "invoice_acompte_applications_amounts_positive" CHECK (
    "applied_ht" > 0 AND "applied_ttc" > 0
    AND "invoice_gross_ht" > 0 AND "invoice_gross_ttc" > 0
    AND "invoice_net_payable_ttc" >= 0
  )
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "invoice_acompte_applications_invoice_unique" ON "invoice_acompte_applications" ("invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "invoice_acompte_applications_devis_unique" ON "invoice_acompte_applications" ("devis_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invoice_acompte_applications_certificat_id_idx" ON "invoice_acompte_applications" ("certificat_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invoice_acompte_applications_source_intake_document_id_idx" ON "invoice_acompte_applications" ("source_intake_document_id");--> statement-breakpoint

CREATE OR REPLACE FUNCTION prevent_invoice_acompte_application_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('app.allow_acompte_application_delete', true) = 'true' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'invoice_acompte_applications rows are immutable';
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS invoice_acompte_applications_immutable_trg ON invoice_acompte_applications;--> statement-breakpoint
CREATE TRIGGER invoice_acompte_applications_immutable_trg
BEFORE UPDATE OR DELETE ON invoice_acompte_applications
FOR EACH ROW EXECUTE FUNCTION prevent_invoice_acompte_application_mutation();--> statement-breakpoint

-- Guarded historical repair. Only exact source-bound rows qualify:
--   * the invoice and audit point to the same fingerprinted intake document;
--   * the live opening-deposit certificat and devis amounts agree;
--   * explicit paid-deposit wording and exact TTC arithmetic agree;
--   * either the immutable operator audit exists or the certificat ledger is
--     fully paid. Mismatches remain untouched for human review.
WITH ledger AS (
  SELECT
    cp.certificat_id,
    round(sum(cp.amount)::numeric, 2) AS paid_ttc,
    max(cp.date_paid) AS paid_at,
    string_agg(DISTINCT NULLIF(btrim(cp.reference), ''), ', ' ORDER BY NULLIF(btrim(cp.reference), '')) AS refs
  FROM certificat_payments cp
  GROUP BY cp.certificat_id
), candidates AS (
  SELECT
    i.id AS invoice_id,
    i.devis_id,
    c.id AS certificat_id,
    i.source_intake_document_id,
    aip.id AS no_invoice_payment_id,
    src.storage_key,
    src.file_name,
    src.content_fingerprint,
    round(COALESCE(NULLIF(d.acompte_amount_ht, 0), d.amount_ht * d.acompte_percent / 100)::numeric, 2) AS applied_ht,
    round((src.extracted_data->>'acomptePaidAmountTtc')::numeric, 2) AS applied_ttc,
    i.amount_ht AS invoice_gross_ht,
    i.amount_ttc AS invoice_gross_ttc,
    round((src.extracted_data->>'netAPayer')::numeric, 2) AS invoice_net_payable_ttc,
    l.paid_at AS payment_ledger_paid_at,
    aip.paid_at AS payment_audit_paid_at,
    l.refs AS payment_ledger_references,
    aip.payment_reference AS payment_audit_reference,
    CASE
      WHEN l.paid_at IS NOT NULL AND aip.paid_at IS NOT NULL
        AND l.paid_at <> (aip.paid_at AT TIME ZONE 'UTC')::date
      THEN true
      WHEN l.refs IS NOT NULL AND aip.payment_reference IS NOT NULL
        AND btrim(aip.payment_reference) <> '' AND position(btrim(aip.payment_reference) in l.refs) = 0
      THEN true
      ELSE false
    END AS payment_conflict,
    src.extracted_data->>'acomptePaidEvidenceText' AS evidence_text
  FROM invoices i
  JOIN devis d ON d.id = i.devis_id
  JOIN project_intake_documents src ON src.id = i.source_intake_document_id
  JOIN certificats c ON c.acompte_devis_id = d.id AND c.status <> 'superseded'
  LEFT JOIN acompte_no_invoice_payments aip
    ON aip.devis_id = d.id
   AND aip.certificat_id = c.id
   AND aip.source_intake_document_id = src.id
   AND aip.source_content_fingerprint = src.content_fingerprint
  LEFT JOIN ledger l ON l.certificat_id = c.id
  WHERE i.source_intake_document_id IS NOT NULL
    AND src.project_id = i.project_id
    AND i.project_id = d.project_id
    AND i.contractor_id = d.contractor_id
    AND c.project_id = d.project_id
    AND c.contractor_id = d.contractor_id
    AND src.content_fingerprint IS NOT NULL
    AND src.extracted_data->>'documentType' = 'invoice'
    AND lower(COALESCE(src.extracted_data->>'acomptePaidEvidenceText', ''))
        ~ '(acompte vers(e|é)|acompte d(e|é)j(a|à) pay(e|é)|d(e|é)duction acompte)'
    AND (src.extracted_data->>'acomptePaidAmountTtc') ~ '^-?[0-9]+([.][0-9]+)?$'
    AND (src.extracted_data->>'netAPayer') ~ '^-?[0-9]+([.][0-9]+)?$'
    AND (
      src.extracted_data->>'retenueDeGarantie' IS NULL
      OR src.extracted_data->>'retenueDeGarantie' ~ '^-?[0-9]+([.][0-9]+)?$'
    )
    AND round((src.extracted_data->>'acomptePaidAmountTtc')::numeric, 2) =
        round(c.net_to_pay_ttc::numeric, 2)
    AND round(c.net_to_pay_ht::numeric, 2) =
        round(COALESCE(NULLIF(d.acompte_amount_ht, 0), d.amount_ht * d.acompte_percent / 100)::numeric, 2)
    AND round(i.amount_ttc::numeric
          - (src.extracted_data->>'acomptePaidAmountTtc')::numeric
          - COALESCE((src.extracted_data->>'retenueDeGarantie')::numeric, 0), 2)
        = round((src.extracted_data->>'netAPayer')::numeric, 2)
    AND (
      aip.id IS NOT NULL
      OR COALESCE(l.paid_ttc, 0) >= round(c.net_to_pay_ttc::numeric, 2)
    )
)
INSERT INTO invoice_acompte_applications (
  invoice_id, devis_id, certificat_id, source_intake_document_id, no_invoice_payment_id,
  source_storage_key, source_file_name, source_content_fingerprint,
  applied_ht, applied_ttc, invoice_gross_ht, invoice_gross_ttc, invoice_net_payable_ttc,
  payment_ledger_paid_at, payment_audit_paid_at, payment_ledger_references,
  payment_audit_reference, payment_conflict, evidence_text
)
SELECT
  invoice_id, devis_id, certificat_id, source_intake_document_id, no_invoice_payment_id,
  storage_key, file_name, content_fingerprint,
  applied_ht, applied_ttc, invoice_gross_ht, invoice_gross_ttc, invoice_net_payable_ttc,
  payment_ledger_paid_at, payment_audit_paid_at, payment_ledger_references,
  payment_audit_reference, payment_conflict, evidence_text
FROM (
  SELECT DISTINCT ON (devis_id) *
  FROM candidates
  ORDER BY devis_id, invoice_id
) exact_once
ON CONFLICT DO NOTHING;--> statement-breakpoint

UPDATE devis d
SET acompte_state = 'applied', updated_at = now()
WHERE d.acompte_state <> 'applied'
  AND EXISTS (
    SELECT 1 FROM invoice_acompte_applications iaa WHERE iaa.devis_id = d.id
  );