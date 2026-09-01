-- An application is an accounting snapshot. Once it exists, retain the invoice
-- facts it proves regardless of which write path reaches the invoices table.
CREATE OR REPLACE FUNCTION prevent_applied_invoice_acompte_fact_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM invoice_acompte_applications iaa WHERE iaa.invoice_id = OLD.id
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
      CONSTRAINT = 'invoice_acompte_invoice_seal',
      MESSAGE = 'invoice_acompte_invoice_sealed';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS invoice_acompte_invoice_seal_trg ON invoices;--> statement-breakpoint
CREATE TRIGGER invoice_acompte_invoice_seal_trg
BEFORE UPDATE OR DELETE ON invoices
FOR EACH ROW EXECUTE FUNCTION prevent_applied_invoice_acompte_fact_mutation();