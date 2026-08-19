-- Task: fix production 500 on milestone payment-suggestion confirm.
-- Production's architect_fee_invoice_events action CHECK drifted back to the
-- pre-0097 value (missing 'milestone_paid') even though 0097 is stamped
-- applied, so the confirm's audit insert violates the constraint. Re-assert
-- the canonical constraint idempotently; safe to run on databases that
-- already have the correct definition.
ALTER TABLE "architect_fee_invoice_events" DROP CONSTRAINT IF EXISTS "architect_fee_invoice_events_action_chk";
--> statement-breakpoint
ALTER TABLE "architect_fee_invoice_events" ADD CONSTRAINT "architect_fee_invoice_events_action_chk" CHECK ("action" IN ('confirmed','dismissed','conflict_parked','replayed','milestone_paid'));
