-- Task: deliberate operator resend of a verified Archisign-signed devis.
-- Existing automatic rows remain intact; manual confirmations append new
-- delivery rows rather than resetting a sent notice.

ALTER TABLE signed_devis_copy_notices
  ADD COLUMN IF NOT EXISTS source text;
ALTER TABLE signed_devis_copy_notices
  ADD COLUMN IF NOT EXISTS request_id text;
ALTER TABLE signed_devis_copy_notices
  ADD COLUMN IF NOT EXISTS requested_by_user_id integer;
ALTER TABLE signed_devis_copy_notices
  ADD COLUMN IF NOT EXISTS confirmation_snapshot jsonb;

UPDATE signed_devis_copy_notices
SET source = 'automatic'
WHERE source IS NULL;

ALTER TABLE signed_devis_copy_notices
  ALTER COLUMN source SET DEFAULT 'automatic';
ALTER TABLE signed_devis_copy_notices
  ALTER COLUMN source SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'signed_devis_copy_notices_requested_by_user_id_users_id_fk'
       AND conrelid = 'signed_devis_copy_notices'::regclass
  ) THEN
    ALTER TABLE signed_devis_copy_notices
      ADD CONSTRAINT signed_devis_copy_notices_requested_by_user_id_users_id_fk
      FOREIGN KEY (requested_by_user_id) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END
$$;

DROP INDEX IF EXISTS signed_devis_copy_notices_devis_envelope_uidx;

CREATE UNIQUE INDEX IF NOT EXISTS signed_devis_copy_notices_automatic_devis_envelope_uidx
  ON signed_devis_copy_notices(devis_id, archisign_envelope_id)
  WHERE source = 'automatic';

CREATE UNIQUE INDEX IF NOT EXISTS signed_devis_copy_notices_manual_request_uidx
  ON signed_devis_copy_notices(request_id)
  WHERE source = 'manual' AND request_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS signed_devis_copy_notices_devis_id_idx
  ON signed_devis_copy_notices(devis_id);