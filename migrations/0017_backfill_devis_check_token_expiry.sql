-- Backfill expiresAt for already-active devis-check portal tokens so the
-- new TTL closes the pre-existing stale-link window. Sliding window
-- starts from last_used_at when present (matches runtime touch
-- behaviour) and falls back to created_at otherwise. The 30-day
-- interval mirrors DEVIS_CHECK_TOKEN_TTL_DAYS' default; deployments
-- running a non-default TTL can run a follow-up UPDATE if needed.
UPDATE "devis_check_tokens"
   SET "expires_at" = COALESCE("last_used_at", "created_at") + INTERVAL '30 days'
 WHERE "revoked_at" IS NULL
   AND "expires_at" IS NULL;
