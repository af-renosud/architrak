-- Invoice rows referenced only by superseded certificates are intentionally
-- mutable: superseded certificates are historical, non-active authorizations.
-- Any non-superseded reference freezes the financial and source identity facts
-- used to create the certificate, regardless of which writer reaches invoices.
CREATE OR REPLACE FUNCTION lock_certificate_source_invoice()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.invoice_id IS NOT NULL THEN
    -- Match the application paths' invoice-row lock. This makes a raw source
    -- claim and a raw invoice mutation commit in a deterministic order.
    PERFORM 1 FROM invoices WHERE id = NEW.invoice_id FOR UPDATE;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS certificat_sources_invoice_lock_trg ON certificat_sources;--> statement-breakpoint
CREATE TRIGGER certificat_sources_invoice_lock_trg
BEFORE INSERT OR UPDATE OF invoice_id ON certificat_sources
FOR EACH ROW EXECUTE FUNCTION lock_certificate_source_invoice();--> statement-breakpoint
CREATE OR REPLACE FUNCTION prevent_certificate_source_invoice_fact_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM certificat_sources cs
    INNER JOIN certificats c ON c.id = cs.certificat_id
    WHERE cs.invoice_id = OLD.id
      AND c.status <> 'superseded'
  ) AND (
    TG_OP = 'DELETE'
    OR OLD.amount_ht IS DISTINCT FROM NEW.amount_ht
    OR OLD.tva_amount IS DISTINCT FROM NEW.tva_amount
    OR OLD.amount_ttc IS DISTINCT FROM NEW.amount_ttc
    OR OLD.devis_id IS DISTINCT FROM NEW.devis_id
    OR OLD.project_id IS DISTINCT FROM NEW.project_id
    OR OLD.contractor_id IS DISTINCT FROM NEW.contractor_id
    OR OLD.source_intake_document_id IS DISTINCT FROM NEW.source_intake_document_id
    OR OLD.pdf_path IS DISTINCT FROM NEW.pdf_path
    OR OLD.ai_extracted_data IS DISTINCT FROM NEW.ai_extracted_data
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'invoice_certificate_source_seal',
      MESSAGE = 'invoice_certificate_source_immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS invoice_certificate_source_seal_trg ON invoices;--> statement-breakpoint
CREATE TRIGGER invoice_certificate_source_seal_trg
BEFORE UPDATE OR DELETE ON invoices
FOR EACH ROW EXECUTE FUNCTION prevent_certificate_source_invoice_fact_mutation();