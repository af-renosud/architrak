CREATE TABLE IF NOT EXISTS certificat_architect_invoices (
  certificat_id integer PRIMARY KEY REFERENCES certificats(id) ON DELETE CASCADE,
  storage_key text,
  file_name text,
  uploaded_at timestamptz,
  uploaded_by text,
  frozen_at timestamptz,
  prepared_by text,
  confirmed_without_invoice boolean NOT NULL DEFAULT false,
  CONSTRAINT certificat_architect_invoice_file_pair CHECK ((storage_key IS NULL) = (file_name IS NULL)),
  CONSTRAINT certificat_architect_invoice_confirmation CHECK (frozen_at IS NULL OR storage_key IS NOT NULL OR confirmed_without_invoice)
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_certificat_architect_invoice() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Honour the parent's existing deletion policy. A direct attempt to erase
  -- delivery history is forbidden; an authorized parent deletion may cascade.
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM certificats WHERE id=OLD.certificat_id) THEN
    RETURN OLD;
  END IF;
  IF OLD.frozen_at IS NOT NULL THEN
    RAISE EXCEPTION 'Architect invoice delivery snapshot is immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS certificat_architect_invoice_frozen ON certificat_architect_invoices;
CREATE TRIGGER certificat_architect_invoice_frozen BEFORE UPDATE OR DELETE ON certificat_architect_invoices
FOR EACH ROW EXECUTE FUNCTION guard_certificat_architect_invoice();
