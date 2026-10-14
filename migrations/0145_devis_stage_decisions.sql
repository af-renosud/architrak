CREATE TABLE IF NOT EXISTS devis_stage_decisions (
  id serial PRIMARY KEY,
  devis_id integer NOT NULL,
  actor_id integer NOT NULL,
  reason text NOT NULL CHECK (length(trim(reason)) >= 10),
  before_state jsonb NOT NULL,
  after_state jsonb NOT NULL,
  created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE OR REPLACE FUNCTION reject_devis_stage_decision_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
  RAISE EXCEPTION 'Devis stage decisions are append-only';
END $$;
DROP TRIGGER IF EXISTS devis_stage_decisions_immutable ON devis_stage_decisions;
CREATE TRIGGER devis_stage_decisions_immutable BEFORE UPDATE OR DELETE ON devis_stage_decisions
FOR EACH ROW EXECUTE FUNCTION reject_devis_stage_decision_mutation();
