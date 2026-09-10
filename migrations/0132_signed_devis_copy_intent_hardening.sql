-- Forward-only hardening after 0131 was applied in development: contractor
-- identity is immutable evidence and must not be nulled by deletion.
ALTER TABLE signed_devis_copy_notices
  DROP CONSTRAINT IF EXISTS signed_devis_copy_notices_intended_contractor_id_fkey;

ALTER TABLE signed_devis_copy_notices
  ALTER COLUMN intended_contractor_id SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'signed_devis_copy_notices_intended_contractor_id_contractors_id_fk'
      AND conrelid = 'signed_devis_copy_notices'::regclass
  ) THEN
    ALTER TABLE signed_devis_copy_notices
      ADD CONSTRAINT signed_devis_copy_notices_intended_contractor_id_contractors_id_fk
      FOREIGN KEY (intended_contractor_id) REFERENCES contractors(id);
  END IF;
END
$$;