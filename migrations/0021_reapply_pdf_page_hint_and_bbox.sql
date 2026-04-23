-- Hotfix (Task #123): re-apply the additive column changes from 0019/0020
-- because drizzle's migrate() silently skipped them on the 2026-04-23 prod
-- deploy (logged "[migrate] done" while applying only 4 of 6 pending
-- migrations). This migration is a no-op on any database where 0019/0020
-- already landed cleanly, and additive on databases where they didn't.
ALTER TABLE "devis_line_items" ADD COLUMN IF NOT EXISTS "pdf_page_hint" integer;--> statement-breakpoint
ALTER TABLE "devis_line_items" ADD COLUMN IF NOT EXISTS "pdf_bbox" jsonb;
