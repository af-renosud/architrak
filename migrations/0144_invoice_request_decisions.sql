CREATE TABLE IF NOT EXISTS invoice_request_decisions (
  id serial PRIMARY KEY,
  invoice_id integer NOT NULL,
  actor text NOT NULL,
  reason text NOT NULL CHECK (length(trim(reason)) >= 20),
  before_state jsonb NOT NULL,
  after_state jsonb NOT NULL,
  created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE OR REPLACE FUNCTION reject_invoice_decision_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
  RAISE EXCEPTION 'Invoice request decisions are append-only';
END $$;
DROP TRIGGER IF EXISTS invoice_request_decisions_immutable ON invoice_request_decisions;
CREATE TRIGGER invoice_request_decisions_immutable BEFORE UPDATE OR DELETE ON invoice_request_decisions
FOR EACH ROW EXECUTE FUNCTION reject_invoice_decision_mutation();
