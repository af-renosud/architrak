-- Mirror table previously accepted arbitrary text. Normalise legacy values to
-- digits-only and null out anything that doesn't match the canonical 14-digit
-- SIRET so the new check constraint can be added safely.
UPDATE "archidoc_contractors"
SET "siret" = regexp_replace("siret", '\D', '', 'g')
WHERE "siret" IS NOT NULL
  AND "siret" !~ '^[0-9]{14}$'
  AND regexp_replace("siret", '\D', '', 'g') ~ '^[0-9]{14}$';

UPDATE "archidoc_contractors"
SET "siret" = NULL
WHERE "siret" IS NOT NULL
  AND "siret" !~ '^[0-9]{14}$';

ALTER TABLE "archidoc_contractors" ADD CONSTRAINT "archidoc_contractors_siret_format" CHECK ("archidoc_contractors"."siret" IS NULL OR "archidoc_contractors"."siret" ~ '^[0-9]{14}$');
