-- Task #450 — Situation traffic-light review.
-- Situations gain the raw AI extraction payload (audit) and a confirm
-- timestamp (draft → confirmed lifecycle); source-PDF evidence uses the
-- Task #449 columns (0071_evidence_attachments). Situation lines gain the
-- AI-claimed percentage and the same per-line traffic-light review fields
-- (check_status / check_notes) used by the devis draft review, so both
-- reviews feel identical.
ALTER TABLE "situations" ADD COLUMN IF NOT EXISTS "ai_extracted_data" jsonb;--> statement-breakpoint
ALTER TABLE "situations" ADD COLUMN IF NOT EXISTS "confirmed_at" timestamp;--> statement-breakpoint
ALTER TABLE "situation_lines" ADD COLUMN IF NOT EXISTS "claimed_percent" numeric(5, 2);--> statement-breakpoint
ALTER TABLE "situation_lines" ADD COLUMN IF NOT EXISTS "check_status" text DEFAULT 'unchecked' NOT NULL;--> statement-breakpoint
ALTER TABLE "situation_lines" ADD COLUMN IF NOT EXISTS "check_notes" text;
