ALTER TABLE certificat_payments
  ADD COLUMN IF NOT EXISTS note text,
  ADD COLUMN IF NOT EXISTS invoice_allocations jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS evidence_storage_key text,
  ADD COLUMN IF NOT EXISTS evidence_file_name text,
  ADD COLUMN IF NOT EXISTS evidence_hash text,
  ADD COLUMN IF NOT EXISTS request_id uuid;
CREATE UNIQUE INDEX IF NOT EXISTS certificat_payments_request_unique
  ON certificat_payments(certificat_id, request_id);
