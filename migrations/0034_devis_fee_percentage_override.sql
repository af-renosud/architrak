-- Per-devis architect-commission override.
-- NULL  = inherit project.fee_percentage (default behaviour, unchanged).
-- 0.00  = explicitly zero — used for professional-services devis that
--         must not carry a works commission.
-- > 0   = use this rate instead of the project rate for any invoice
--         approved against this devis.
ALTER TABLE devis
  ADD COLUMN IF NOT EXISTS fee_percentage_override numeric(5, 2);

ALTER TABLE devis
  ADD CONSTRAINT devis_fee_percentage_override_range
  CHECK (fee_percentage_override IS NULL
         OR (fee_percentage_override >= 0 AND fee_percentage_override <= 100));
