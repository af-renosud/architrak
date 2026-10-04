CREATE TABLE IF NOT EXISTS duplicate_extraction_audit (
  id serial PRIMARY KEY,
  devis_id integer NOT NULL,
  removed_line_id integer NOT NULL UNIQUE,
  retained_line_id integer NOT NULL,
  actor_id integer NOT NULL,
  reason text NOT NULL CHECK (length(trim(reason)) > 0),
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION guard_duplicate_extraction_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Extraction correction audit is immutable';
END;
$$;
DROP TRIGGER IF EXISTS duplicate_extraction_audit_immutable ON duplicate_extraction_audit;
CREATE TRIGGER duplicate_extraction_audit_immutable BEFORE UPDATE OR DELETE ON duplicate_extraction_audit
FOR EACH ROW EXECUTE FUNCTION guard_duplicate_extraction_audit();