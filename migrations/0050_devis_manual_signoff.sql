-- Manual sign-off provenance — secondary signing pathway alongside the
-- Archisign webhook. Lets an operator authenticate a devis as signed by
-- uploading the signed copy directly (paper signature, envelope signed
-- inside Archisign but outside the ArchiDoc↔Archisign integration, or
-- another e-sign provider), with a mandatory audit note and an optional
-- external reference for correlation.
--
-- signed_off_via is NULL for all pre-existing rows; consumers treat a
-- NULL on a client_signed_off devis as "archisign" (the only path that
-- existed before this migration).

ALTER TABLE devis
  ADD COLUMN IF NOT EXISTS signed_off_via text,
  ADD COLUMN IF NOT EXISTS manual_signoff_at timestamptz,
  ADD COLUMN IF NOT EXISTS manual_signoff_by text,
  ADD COLUMN IF NOT EXISTS manual_signoff_note text,
  ADD COLUMN IF NOT EXISTS manual_signoff_external_ref text;
