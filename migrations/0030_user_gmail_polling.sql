-- 2026-05-08 — Per-user Gmail polling tokens (Path 1 of inbox-monitoring fix).
--
-- Background: the Replit-managed `google-mail` connector exposes only
-- gmail.send + a handful of addon scopes. Inbox polling needs gmail.readonly
-- (or gmail.modify) to call users.messages.list, which the connector does not
-- grant. After re-authorising the connector the dashboard's "Re-authorize
-- Gmail (read scope needed)" badge persisted because no available scope
-- expansion would unblock it.
--
-- Path 1 fix: extend the existing Google Workspace login OAuth with the
-- gmail.readonly scope (server/auth/google-oauth.ts), capture the user's
-- refresh_token at /api/auth/callback, and switch server/gmail/monitor.ts
-- to iterate every architect with a refresh_token + polling enabled and
-- poll their inbox using a per-user OAuth2 client. Each user's last poll
-- result is tracked on their own row so the dashboard can display a clean
-- per-user state.
--
-- Tokens are sensitive — they are never logged, never returned from
-- /api/auth/user, and the gmail_access_token / gmail_token_expires_at
-- columns are ephemeral (refreshed automatically by google-auth-library).

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "gmail_refresh_token" text,
  ADD COLUMN IF NOT EXISTS "gmail_access_token" text,
  ADD COLUMN IF NOT EXISTS "gmail_token_expires_at" timestamp,
  ADD COLUMN IF NOT EXISTS "gmail_scope_granted" text,
  ADD COLUMN IF NOT EXISTS "gmail_polling_enabled" boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "gmail_last_poll_at" timestamp,
  ADD COLUMN IF NOT EXISTS "gmail_last_poll_status" text,
  ADD COLUMN IF NOT EXISTS "gmail_last_poll_error" text;

-- Partial index lets the monitor loop find polling-eligible users in O(log n)
-- without scanning the whole users table on every 15-min tick.
CREATE INDEX IF NOT EXISTS "users_gmail_polling_idx"
  ON "users" ("id")
  WHERE "gmail_refresh_token" IS NOT NULL AND "gmail_polling_enabled" = true;
