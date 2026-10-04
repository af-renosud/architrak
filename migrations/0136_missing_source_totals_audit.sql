CREATE TABLE IF NOT EXISTS quotation_source_transcriptions (
  id serial PRIMARY KEY,
  devis_id integer NOT NULL,
  actor_id integer NOT NULL,
  reason text NOT NULL CHECK (length(trim(reason)) > 0),
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
DROP TRIGGER IF EXISTS quotation_source_transcriptions_immutable ON quotation_source_transcriptions;
CREATE TRIGGER quotation_source_transcriptions_immutable
BEFORE UPDATE OR DELETE ON quotation_source_transcriptions
FOR EACH ROW EXECUTE FUNCTION guard_duplicate_extraction_audit();