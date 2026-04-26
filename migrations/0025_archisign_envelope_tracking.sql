-- AT4 (#152) — Archisign envelope tracking columns on devis (contract §3.5.1 / §1.2).
-- All additive + nullable. The accessUrl is the ONLY persisted URL; it
-- comes from /create's response and is never overwritten by /send (G3).
-- archisign_access_url_invalidated_at is set on `envelope.expired` to
-- soft-invalidate while preserving for audit (§1.2).

ALTER TABLE "devis"
  ADD COLUMN IF NOT EXISTS "archisign_access_url" text,
  ADD COLUMN IF NOT EXISTS "archisign_access_url_invalidated_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "archisign_envelope_status" text,
  ADD COLUMN IF NOT EXISTS "archisign_envelope_expires_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "archisign_otp_destination" text;

-- Status whitelist (matches Archisign's six terminal+intermediate states +
-- the rare retention_breach which is informational and does not mutate
-- this column — that path writes to signed_pdf_retention_breaches instead).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'devis_archisign_envelope_status_check'
  ) THEN
    ALTER TABLE "devis"
      ADD CONSTRAINT "devis_archisign_envelope_status_check"
      CHECK (
        "archisign_envelope_status" IS NULL
        OR "archisign_envelope_status" IN (
          'sent', 'viewed', 'queried', 'signed', 'declined', 'expired'
        )
      );
  END IF;
END$$;
