-- Task #617 — draft "client paid" suggestions for design-contract milestones,
-- detected from client replies on the Gmail thread of the firm's own invoiced
-- honoraires facture. Mirrors certificat_payment_suggestions (draft → human
-- confirmation; nothing auto-recorded).
CREATE TABLE IF NOT EXISTS "milestone_payment_suggestions" (
  "id" serial PRIMARY KEY NOT NULL,
  "milestone_id" integer NOT NULL,
  "project_id" integer NOT NULL,
  "architect_fee_invoice_id" integer,
  "email_message_id" text NOT NULL,
  "email_thread_id" text NOT NULL,
  "sender_email" text NOT NULL,
  "email_date" timestamp NOT NULL,
  "matched_excerpt" text,
  "suggested_amount" numeric(12, 2) NOT NULL,
  "suggested_date" date NOT NULL,
  "status" text DEFAULT 'pending_review' NOT NULL,
  "reviewed_by" text,
  "reviewed_at" timestamp,
  "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  CONSTRAINT "milestone_payment_suggestions_message_unique" UNIQUE("email_message_id"),
  CONSTRAINT "milestone_payment_suggestions_status_check" CHECK ("status" IN ('pending_review', 'ambiguous', 'confirmed', 'dismissed'))
);
--> statement-breakpoint
ALTER TABLE "milestone_payment_suggestions" ADD CONSTRAINT "milestone_payment_suggestions_milestone_id_design_contract_milestones_id_fk" FOREIGN KEY ("milestone_id") REFERENCES "public"."design_contract_milestones"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "milestone_payment_suggestions" ADD CONSTRAINT "milestone_payment_suggestions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "milestone_payment_suggestions_pending_unique" ON "milestone_payment_suggestions" ("milestone_id") WHERE "status" = 'pending_review';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "milestone_payment_suggestions_milestone_id_idx" ON "milestone_payment_suggestions" ("milestone_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "milestone_payment_suggestions_project_id_idx" ON "milestone_payment_suggestions" ("project_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "milestone_payment_suggestions_status_idx" ON "milestone_payment_suggestions" ("status");
--> statement-breakpoint
-- Confirming a milestone payment suggestion audits on the bound evidence row:
-- extend the append-only event action set with 'milestone_paid'.
ALTER TABLE "architect_fee_invoice_events" DROP CONSTRAINT IF EXISTS "architect_fee_invoice_events_action_chk";
--> statement-breakpoint
ALTER TABLE "architect_fee_invoice_events" ADD CONSTRAINT "architect_fee_invoice_events_action_chk" CHECK ("action" IN ('confirmed','dismissed','conflict_parked','replayed','milestone_paid'));
