ALTER TABLE "certificats"
  ADD COLUMN IF NOT EXISTS "tva_evidence_kind" text NOT NULL DEFAULT 'legacy';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'certificats'::regclass
      AND conname = 'certificats_tva_evidence_kind_chk'
  ) THEN
    ALTER TABLE "certificats"
      ADD CONSTRAINT "certificats_tva_evidence_kind_chk"
      CHECK (
        "tva_evidence_kind" IN (
          'configuration',
          'signed_quotation',
          'exact_invoices',
          'legacy'
        )
      );
  END IF;
END
$$;