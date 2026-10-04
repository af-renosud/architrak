CREATE TABLE IF NOT EXISTS quotation_extraction_events (
  id serial PRIMARY KEY,
  devis_id integer NOT NULL,
  actor_id integer,
  kind text NOT NULL CHECK (kind IN ('attempt','review','replacement')),
  outcome text NOT NULL,
  category text,
  reason text,
  effort_minutes integer NOT NULL DEFAULT 0 CHECK (effort_minutes >= 0),
  snapshot jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS quotation_extraction_events_devis_idx ON quotation_extraction_events(devis_id,created_at);
DROP TRIGGER IF EXISTS quotation_extraction_events_immutable ON quotation_extraction_events;
CREATE TRIGGER quotation_extraction_events_immutable BEFORE UPDATE OR DELETE ON quotation_extraction_events
FOR EACH ROW EXECUTE FUNCTION guard_duplicate_extraction_audit();
CREATE OR REPLACE FUNCTION audit_quotation_extraction_insert() RETURNS trigger AS $$
BEGIN
  IF NEW.ai_extracted_data IS NOT NULL THEN
    INSERT INTO quotation_extraction_events(devis_id,kind,outcome)
    VALUES(NEW.id,'attempt',CASE WHEN NEW.ai_extracted_data->'quotationVerification'->>'verified'='false'
      THEN 'failed' ELSE 'completed_unreviewed' END);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS quotation_extraction_attempt_inserted ON devis;
CREATE TRIGGER quotation_extraction_attempt_inserted AFTER INSERT ON devis
FOR EACH ROW EXECUTE FUNCTION audit_quotation_extraction_insert();