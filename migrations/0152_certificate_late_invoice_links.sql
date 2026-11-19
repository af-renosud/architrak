ALTER TABLE certificat_sources ADD COLUMN IF NOT EXISTS late_association jsonb;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_certificate_late_association() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.late_association IS NOT NULL AND
    (NEW.late_association IS DISTINCT FROM OLD.late_association
      OR NEW.invoice_id IS DISTINCT FROM OLD.invoice_id
      OR NEW.certificat_id IS DISTINCT FROM OLD.certificat_id) THEN
    RAISE EXCEPTION 'Late invoice association is immutable';
  END IF;
  IF NEW.late_association IS NOT NULL AND
    (NEW.invoice_id IS NULL OR
     length(trim(COALESCE(NEW.late_association->>'reason',''))) < 10 OR
     COALESCE(NEW.late_association->>'actor','') = '' OR
     COALESCE(NEW.late_association->>'linkedAt','') = '') THEN
    RAISE EXCEPTION 'Late invoice association requires invoice and confirmation evidence';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS certificate_late_association_guard ON certificat_sources;
CREATE TRIGGER certificate_late_association_guard BEFORE INSERT OR UPDATE ON certificat_sources
FOR EACH ROW EXECUTE FUNCTION guard_certificate_late_association();
