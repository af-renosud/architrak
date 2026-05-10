-- 2026-05-10 — Add image attachments to wish list items.
--
-- Lets architects paste screenshots directly from the clipboard into
-- the Settings → Wish List form (saves the round-trip through a file
-- picker). Storage keys point at object storage entries created via
-- POST /api/wish-list/upload-image; the column is a plain text array
-- so existing rows back-fill to an empty list without a default-value
-- migration dance.

ALTER TABLE "wish_list_items"
  ADD COLUMN IF NOT EXISTS "image_storage_keys" text[] NOT NULL DEFAULT '{}'::text[];
