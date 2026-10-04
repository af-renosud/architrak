CREATE TABLE IF NOT EXISTS extraction_row_corrections (
  id serial PRIMARY KEY,
  devis_id integer NOT NULL,
  line_id integer NOT NULL,
  actor_id integer NOT NULL,
  reason text NOT NULL CHECK (length(trim(reason)) > 0),
  fingerprint text NOT NULL UNIQUE,
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
DROP TRIGGER IF EXISTS extraction_row_corrections_immutable ON extraction_row_corrections;
CREATE TRIGGER extraction_row_corrections_immutable BEFORE UPDATE OR DELETE ON extraction_row_corrections
FOR EACH ROW EXECUTE FUNCTION guard_duplicate_extraction_audit();