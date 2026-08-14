-- Task #466 — record WHICH linked Gmail account sent each communication.
-- The payment-reply scanner must read the mailbox that owns the thread;
-- sends now go through the architect's linked per-user OAuth client
-- (gmail.modify scope includes send) whenever one exists, and this column
-- binds the communication to that mailbox. NULL = legacy/connector sends,
-- which every linked inbox probes (404 = not-my-mailbox skip).
ALTER TABLE "project_communications" ADD COLUMN "sent_via_user_id" integer;
--> statement-breakpoint
ALTER TABLE "project_communications" ADD CONSTRAINT "project_communications_sent_via_user_id_users_id_fk" FOREIGN KEY ("sent_via_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
