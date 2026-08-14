-- Task #466 — draft payment suggestions detected from client "paid"
-- confirmation replies on sent-certificat Gmail threads. Nothing is
-- auto-recorded: the architect confirms (writing a certificat_payments row
-- with source='email') or dismisses. email_message_id is unique for
-- idempotent re-polls; the partial unique index caps open suggestions at
-- one per certificat so duplicate replies never stack.
CREATE TABLE "certificat_payment_suggestions" (
	"id" serial PRIMARY KEY NOT NULL,
	"certificat_id" integer NOT NULL,
	"project_id" integer NOT NULL,
	"communication_id" integer NOT NULL,
	"email_message_id" text NOT NULL,
	"email_thread_id" text NOT NULL,
	"sender_email" text NOT NULL,
	"email_date" timestamp NOT NULL,
	"matched_excerpt" text,
	"suggested_amount" numeric(12, 2) NOT NULL,
	"suggested_date" date NOT NULL,
	"status" text DEFAULT 'pending_review' NOT NULL,
	"payment_id" integer,
	"reviewed_by" text,
	"reviewed_at" timestamp,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "certificat_payment_suggestions_message_unique" UNIQUE("email_message_id"),
	CONSTRAINT "certificat_payment_suggestions_status_check" CHECK ("certificat_payment_suggestions"."status" IN ('pending_review', 'ambiguous', 'confirmed', 'dismissed'))
);
--> statement-breakpoint
ALTER TABLE "certificat_payment_suggestions" ADD CONSTRAINT "certificat_payment_suggestions_certificat_id_certificats_id_fk" FOREIGN KEY ("certificat_id") REFERENCES "public"."certificats"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "certificat_payment_suggestions" ADD CONSTRAINT "certificat_payment_suggestions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "certificat_payment_suggestions_pending_unique" ON "certificat_payment_suggestions" USING btree ("certificat_id") WHERE "certificat_payment_suggestions"."status" = 'pending_review';
--> statement-breakpoint
CREATE INDEX "certificat_payment_suggestions_certificat_id_idx" ON "certificat_payment_suggestions" USING btree ("certificat_id");
--> statement-breakpoint
CREATE INDEX "certificat_payment_suggestions_project_id_idx" ON "certificat_payment_suggestions" USING btree ("project_id");
--> statement-breakpoint
CREATE INDEX "certificat_payment_suggestions_status_idx" ON "certificat_payment_suggestions" USING btree ("status");
