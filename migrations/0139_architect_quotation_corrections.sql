CREATE TABLE IF NOT EXISTS quotation_source_baselines (
  devis_id integer PRIMARY KEY,
  source_storage_key text NOT NULL,
  source_file_name text NOT NULL,
  source_digest text NOT NULL CHECK (source_digest ~ '^[a-f0-9]{64}$'),
  ttc numeric(12,2) NOT NULL CHECK (ttc >= 0),
  pdf_page integer NOT NULL CHECK (pdf_page > 0),
  actor_id integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS quotation_architect_state (
  devis_id integer PRIMARY KEY,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  draft jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS quotation_architect_audit (
  id serial PRIMARY KEY,
  devis_id integer NOT NULL,
  actor_id integer NOT NULL,
  operation text NOT NULL CHECK (operation IN ('baseline','correction')),
  before_snapshot jsonb NOT NULL,
  after_snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS quotation_architect_audit_devis_idx ON quotation_architect_audit(devis_id,id);
DROP TRIGGER IF EXISTS quotation_source_baselines_immutable ON quotation_source_baselines;
CREATE TRIGGER quotation_source_baselines_immutable BEFORE UPDATE OR DELETE ON quotation_source_baselines
FOR EACH ROW EXECUTE FUNCTION guard_duplicate_extraction_audit();
DROP TRIGGER IF EXISTS quotation_architect_audit_immutable ON quotation_architect_audit;
CREATE TRIGGER quotation_architect_audit_immutable BEFORE UPDATE OR DELETE ON quotation_architect_audit
FOR EACH ROW EXECUTE FUNCTION guard_duplicate_extraction_audit();
CREATE OR REPLACE FUNCTION guard_architect_quotation_source() RETURNS trigger AS $$
BEGIN
  IF (EXISTS(SELECT 1 FROM quotation_source_baselines WHERE devis_id=OLD.id)
      OR EXISTS(SELECT 1 FROM quotation_architect_state WHERE devis_id=OLD.id))
    AND (NEW.pdf_storage_key IS DISTINCT FROM OLD.pdf_storage_key
      OR NEW.ai_extracted_data IS DISTINCT FROM OLD.ai_extracted_data) THEN
    RAISE EXCEPTION 'Original PDF and extraction are preserved after source confirmation';
  END IF;
  IF EXISTS(SELECT 1 FROM quotation_architect_state WHERE devis_id=OLD.id)
    AND current_setting('renosud.architect_correction',true) IS DISTINCT FROM 'on'
    AND (NEW.amount_ht IS DISTINCT FROM OLD.amount_ht OR NEW.amount_ttc IS DISTINCT FROM OLD.amount_ttc
      OR NEW.description_fr IS DISTINCT FROM OLD.description_fr) THEN
    RAISE EXCEPTION 'Use the architect correction editor for working quotation content';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS devis_architect_source_guard ON devis;
CREATE TRIGGER devis_architect_source_guard BEFORE UPDATE ON devis
FOR EACH ROW EXECUTE FUNCTION guard_architect_quotation_source();
CREATE OR REPLACE FUNCTION guard_architect_quotation_lines() RETURNS trigger AS $$
DECLARE quote_id integer;
BEGIN
  quote_id := CASE WHEN TG_OP='DELETE' THEN OLD.devis_id ELSE NEW.devis_id END;
  IF (EXISTS(SELECT 1 FROM quotation_architect_state WHERE devis_id=quote_id)
      OR (TG_OP='UPDATE' AND EXISTS(SELECT 1 FROM quotation_architect_state WHERE devis_id=OLD.devis_id)))
    AND current_setting('renosud.architect_correction',true) IS DISTINCT FROM 'on' THEN
    IF TG_OP <> 'UPDATE' THEN RAISE EXCEPTION 'Use the architect correction editor for working rows'; END IF;
    IF ROW(NEW.devis_id,NEW.line_number,NEW.description,NEW.quantity,NEW.unit,NEW.unit_price_ht,NEW.total_ht)
      IS DISTINCT FROM ROW(OLD.devis_id,OLD.line_number,OLD.description,OLD.quantity,OLD.unit,OLD.unit_price_ht,OLD.total_ht) THEN
      RAISE EXCEPTION 'Use the architect correction editor for working rows';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS devis_architect_line_guard ON devis_line_items;
CREATE TRIGGER devis_architect_line_guard BEFORE INSERT OR UPDATE OR DELETE ON devis_line_items
FOR EACH ROW EXECUTE FUNCTION guard_architect_quotation_lines();
CREATE OR REPLACE FUNCTION guard_architect_quotation_translation() RETURNS trigger AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM quotation_architect_state WHERE devis_id=NEW.devis_id)
    AND current_setting('renosud.architect_correction',true) IS DISTINCT FROM 'on'
    AND (NEW.header_translated IS DISTINCT FROM OLD.header_translated
      OR NEW.line_translations IS DISTINCT FROM OLD.line_translations
      OR NEW.status IN ('processing','failed')) THEN
    RAISE EXCEPTION 'Architect translations cannot be overwritten by background processing';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS devis_architect_translation_guard ON devis_translations;
CREATE TRIGGER devis_architect_translation_guard BEFORE UPDATE ON devis_translations
FOR EACH ROW EXECUTE FUNCTION guard_architect_quotation_translation();
