-- Task #407 — copy the project client link any time.
-- Stores the full share URL encrypted at rest (AES-256-GCM, key derived
-- from SESSION_SECRET). The token hash remains the ONLY lookup path for
-- the public route; this column exists solely so the authenticated panel
-- can re-copy the link. NULL for rows issued before this migration
-- (those offer copy only after the next rotate).
ALTER TABLE "client_project_share_tokens"
  ADD COLUMN "encrypted_share_url" text;
