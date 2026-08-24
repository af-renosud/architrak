ALTER TABLE "certificats"
  ADD COLUMN IF NOT EXISTS "certificate_track" text;

UPDATE "certificats"
SET "certificate_track" = 'contractor_works'
WHERE "certificate_track" IS NULL;

ALTER TABLE "certificats"
  ALTER COLUMN "certificate_track" SET DEFAULT 'contractor_works',
  ALTER COLUMN "certificate_track" SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'certificats_certificate_track_check'
  ) THEN
    ALTER TABLE "certificats"
      ADD CONSTRAINT "certificats_certificate_track_check"
      CHECK ("certificate_track" IN ('contractor_works', 'supplier_direct_payment'));
  END IF;
END $$;