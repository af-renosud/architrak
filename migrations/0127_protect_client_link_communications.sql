ALTER TABLE "project_communications" ADD COLUMN IF NOT EXISTS "encrypted_body" text;

-- NOT VALID keeps legacy rows available for the application-key backfill, but
-- immediately blocks old application instances (and generic writers) from
-- persisting any new unprotected client-link communication during rollout.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'project_communications'::regclass
      AND conname = 'project_communications_client_link_protected_chk'
  ) THEN
    ALTER TABLE "project_communications"
      ADD CONSTRAINT "project_communications_client_link_protected_chk"
      CHECK (
        "type" <> 'devis_client_link'
        OR (
          "encrypted_body" IS NOT NULL
          AND "body" IS NOT NULL
          AND "body" NOT LIKE '%/p/client/%'
        )
      ) NOT VALID;
  END IF;
END
$$;