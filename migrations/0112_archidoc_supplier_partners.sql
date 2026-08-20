ALTER TABLE "archidoc_contractors"
  ADD COLUMN IF NOT EXISTS "partner_type" varchar(32) NOT NULL DEFAULT 'contractor';

ALTER TABLE "contractors"
  ADD COLUMN IF NOT EXISTS "archidoc_partner_type" varchar(32);

UPDATE "contractors"
SET "archidoc_partner_type" = 'contractor'
WHERE "archidoc_id" IS NOT NULL
  AND "archidoc_partner_type" IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'archidoc_contractors_partner_type_chk'
  ) THEN
    ALTER TABLE "archidoc_contractors"
      ADD CONSTRAINT "archidoc_contractors_partner_type_chk"
      CHECK ("partner_type" IN ('contractor', 'supplier'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'contractors_archidoc_partner_type_chk'
  ) THEN
    ALTER TABLE "contractors"
      ADD CONSTRAINT "contractors_archidoc_partner_type_chk"
      CHECK (
        "archidoc_partner_type" IS NULL
        OR "archidoc_partner_type" IN ('contractor', 'supplier')
      );
  END IF;
END $$;