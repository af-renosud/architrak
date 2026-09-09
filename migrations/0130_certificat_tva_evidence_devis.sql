ALTER TABLE "certificats"
  ADD COLUMN IF NOT EXISTS "tva_evidence_devis_id" integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'certificats'::regclass
      AND conname = 'certificats_tva_evidence_devis_id_devis_id_fk'
  ) THEN
    ALTER TABLE "certificats"
      ADD CONSTRAINT "certificats_tva_evidence_devis_id_devis_id_fk"
      FOREIGN KEY ("tva_evidence_devis_id")
      REFERENCES "devis"("id")
      ON DELETE RESTRICT;
  END IF;
END
$$;