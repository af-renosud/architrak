ALTER TABLE devis
  ADD COLUMN IF NOT EXISTS signed_pdf_archisign_envelope_id text;

ALTER TABLE project_communications
  ADD COLUMN IF NOT EXISTS related_devis_id integer REFERENCES devis(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS signed_devis_copy_notices (
  id serial PRIMARY KEY,
  devis_id integer NOT NULL REFERENCES devis(id) ON DELETE CASCADE,
  project_id integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  archisign_envelope_id text NOT NULL,
  intended_contractor_id integer REFERENCES contractors(id) ON DELETE SET NULL,
  signed_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending_pdf',
  communication_id integer REFERENCES project_communications(id) ON DELETE SET NULL,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_error text,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS signed_devis_copy_notices_devis_envelope_uidx
  ON signed_devis_copy_notices(devis_id, archisign_envelope_id);
CREATE INDEX IF NOT EXISTS signed_devis_copy_notices_due_idx
  ON signed_devis_copy_notices(status, next_attempt_at);