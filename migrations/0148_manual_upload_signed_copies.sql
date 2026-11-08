-- Operator-attested uploaded signatures have no Archisign envelope.
-- Existing rows remain unchanged. Never manufacture envelope identifiers.
ALTER TABLE signed_devis_copy_notices ALTER COLUMN archisign_envelope_id DROP NOT NULL;
ALTER TABLE signed_devis_copy_notices DROP CONSTRAINT IF EXISTS signed_copy_envelope_provenance;
ALTER TABLE signed_devis_copy_notices ADD CONSTRAINT signed_copy_envelope_provenance CHECK (
  archisign_envelope_id IS NOT NULL OR (
    source = 'manual' AND
    (confirmation_snapshot->>'signatureSource') IS NOT DISTINCT FROM 'manual_upload' AND
    COALESCE(confirmation_snapshot->>'manualAttestationHash', '') ~ '^[a-f0-9]{64}$' AND
    COALESCE(confirmation_snapshot->>'signedPdfContentHash', '') ~ '^[a-f0-9]{64}$'
  )
);
