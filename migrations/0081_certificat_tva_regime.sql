-- Task #463 — Contractor/contract-specific TVA rate & autoliquidation.
-- Certificats were hardcoded at 20% TVA. The regime now lives on the marché
-- (falling back to a contractor-level default, then 20%); each certificat
-- persists the rate actually applied (audit) plus the autoliquidation flag
-- (0% TVA, "TVA due par le preneur — art. 283 CGI" mention on the PDF).

ALTER TABLE "contractors"
  ADD COLUMN "default_tva_rate_percent" numeric(5, 2),
  ADD COLUMN "default_tva_autoliquidation" boolean NOT NULL DEFAULT false;

ALTER TABLE "marches"
  ADD COLUMN "tva_rate_percent" numeric(5, 2),
  ADD COLUMN "tva_autoliquidation" boolean NOT NULL DEFAULT false;

-- Existing certificats were all computed at 20% — the default backfills the
-- audit column with the historically correct value; stored amounts untouched.
ALTER TABLE "certificats"
  ADD COLUMN "tva_rate_percent" numeric(5, 2) NOT NULL DEFAULT '20.00',
  ADD COLUMN "tva_autoliquidation" boolean NOT NULL DEFAULT false;
