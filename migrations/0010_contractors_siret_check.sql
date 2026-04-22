-- Normalise legacy SIRET values: strip non-digits, then null out anything that isn't 14 digits.
UPDATE "contractors"
SET "siret" = NULL
WHERE "siret" IS NOT NULL
  AND regexp_replace("siret", '\D', '', 'g') !~ '^[0-9]{14}$';

UPDATE "contractors"
SET "siret" = regexp_replace("siret", '\D', '', 'g')
WHERE "siret" IS NOT NULL
  AND "siret" !~ '^[0-9]{14}$'
  AND regexp_replace("siret", '\D', '', 'g') ~ '^[0-9]{14}$';

ALTER TABLE "contractors"
  ADD CONSTRAINT "contractors_siret_format"
  CHECK ("siret" IS NULL OR "siret" ~ '^[0-9]{14}$');
