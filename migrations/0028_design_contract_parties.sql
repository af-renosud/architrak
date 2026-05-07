-- Persist the parties + project address that the Gemini extractor pulls
-- out of design contracts. Surfaced in the architect review modal and
-- the project-detail Design Contract card.

ALTER TABLE "design_contracts"
  ADD COLUMN IF NOT EXISTS "client_name" text,
  ADD COLUMN IF NOT EXISTS "architect_name" text,
  ADD COLUMN IF NOT EXISTS "project_address" text;
