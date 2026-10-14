CREATE TABLE IF NOT EXISTS archidoc_supplier_directory (
  id text PRIMARY KEY,
  source_base_url text NOT NULL,
  contractor_id integer NOT NULL REFERENCES contractors(id),
  snapshot_id text NOT NULL,
  data jsonb NOT NULL,
  is_absent boolean NOT NULL DEFAULT false,
  synced_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
);
