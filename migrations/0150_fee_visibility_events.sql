CREATE TABLE IF NOT EXISTS fee_visibility_events (
  id serial PRIMARY KEY,
  fee_id integer NOT NULL REFERENCES fees(id),
  entry_id integer REFERENCES fee_entries(id),
  action text NOT NULL,
  reason text NOT NULL,
  actor text NOT NULL,
  created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fee_visibility_events_action_check CHECK (action IN ('archive','restore')),
  CONSTRAINT fee_visibility_events_reason_check CHECK (length(trim(reason)) BETWEEN 1 AND 2000)
);
CREATE INDEX IF NOT EXISTS fee_visibility_events_record_idx ON fee_visibility_events (fee_id, entry_id, id);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='fee_visibility_events'::regclass AND conname='fee_visibility_events_pkey') THEN
    ALTER TABLE fee_visibility_events ADD CONSTRAINT fee_visibility_events_pkey PRIMARY KEY (id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='fee_visibility_events'::regclass AND conname='fee_visibility_events_fee_id_fkey') THEN
    ALTER TABLE fee_visibility_events ADD CONSTRAINT fee_visibility_events_fee_id_fkey FOREIGN KEY (fee_id) REFERENCES fees(id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='fee_visibility_events'::regclass AND conname='fee_visibility_events_entry_id_fkey') THEN
    ALTER TABLE fee_visibility_events ADD CONSTRAINT fee_visibility_events_entry_id_fkey FOREIGN KEY (entry_id) REFERENCES fee_entries(id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='fee_visibility_events'::regclass AND conname='fee_visibility_events_action_check') THEN
    ALTER TABLE fee_visibility_events ADD CONSTRAINT fee_visibility_events_action_check CHECK (action IN ('archive','restore'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='fee_visibility_events'::regclass AND conname='fee_visibility_events_reason_check') THEN
    ALTER TABLE fee_visibility_events ADD CONSTRAINT fee_visibility_events_reason_check CHECK (length(trim(reason)) BETWEEN 1 AND 2000);
  END IF;
END; $$;
CREATE OR REPLACE FUNCTION protect_fee_visibility_events() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Fee visibility history is append-only';
END; $$;
DROP TRIGGER IF EXISTS fee_visibility_events_immutable ON fee_visibility_events;
CREATE TRIGGER fee_visibility_events_immutable BEFORE UPDATE OR DELETE ON fee_visibility_events
FOR EACH ROW EXECUTE FUNCTION protect_fee_visibility_events();
