CREATE TABLE IF NOT EXISTS contractor_external_deliveries (
  id serial PRIMARY KEY,
  devis_id integer NOT NULL REFERENCES devis(id),
  document_version text NOT NULL,
  request_id text NOT NULL,
  recorded_by integer NOT NULL REFERENCES users(id),
  sent_on text NOT NULL,
  method text NOT NULL,
  recipient text NOT NULL,
  note text NOT NULL DEFAULT '',
  recorded_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS contractor_external_deliveries_request_uidx
  ON contractor_external_deliveries(request_id);
CREATE INDEX IF NOT EXISTS contractor_external_deliveries_devis_idx
  ON contractor_external_deliveries(devis_id);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='contractor_external_deliveries'::regclass AND conname='contractor_external_deliveries_pkey') THEN
    ALTER TABLE contractor_external_deliveries ADD CONSTRAINT contractor_external_deliveries_pkey PRIMARY KEY (id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='contractor_external_deliveries'::regclass AND conname='contractor_external_deliveries_devis_id_fkey') THEN
    ALTER TABLE contractor_external_deliveries ADD CONSTRAINT contractor_external_deliveries_devis_id_fkey FOREIGN KEY (devis_id) REFERENCES devis(id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='contractor_external_deliveries'::regclass AND conname='contractor_external_deliveries_recorded_by_fkey') THEN
    ALTER TABLE contractor_external_deliveries ADD CONSTRAINT contractor_external_deliveries_recorded_by_fkey FOREIGN KEY (recorded_by) REFERENCES users(id);
  END IF;
END; $$;
