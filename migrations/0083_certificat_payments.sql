-- Task #465 — structured client payment logging.
-- certificat_payments: ledger of received payments per certificat (partial
-- payments accumulate; the certificat flips to 'paid' only when the summed
-- amounts cover net_to_pay_ttc, computed server-side).
-- certificat_payment_audits: append-only trail of ledger edits.

CREATE TABLE IF NOT EXISTS "certificat_payments" (
	"id" serial PRIMARY KEY NOT NULL,
	"certificat_id" integer NOT NULL,
	"date_paid" date NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"method" text DEFAULT 'virement' NOT NULL,
	"reference" text,
	"logged_by" text,
	"source" text DEFAULT 'manual' NOT NULL,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "certificat_payments_amount_positive" CHECK ("amount" > 0),
	CONSTRAINT "certificat_payments_method_check" CHECK ("method" IN ('virement', 'cheque', 'autre')),
	CONSTRAINT "certificat_payments_source_check" CHECK ("source" IN ('manual', 'email'))
);
--> statement-breakpoint
ALTER TABLE "certificat_payments" ADD CONSTRAINT "certificat_payments_certificat_id_certificats_id_fk" FOREIGN KEY ("certificat_id") REFERENCES "public"."certificats"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "certificat_payments_certificat_id_idx" ON "certificat_payments" ("certificat_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "certificat_payment_audits" (
	"id" serial PRIMARY KEY NOT NULL,
	"certificat_id" integer NOT NULL,
	"payment_id" integer NOT NULL,
	"action" text NOT NULL,
	"snapshot" jsonb,
	"changed_by" text,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "certificat_payment_audits_action_check" CHECK ("action" IN ('created', 'updated', 'deleted'))
);
--> statement-breakpoint
ALTER TABLE "certificat_payment_audits" ADD CONSTRAINT "certificat_payment_audits_certificat_id_certificats_id_fk" FOREIGN KEY ("certificat_id") REFERENCES "public"."certificats"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "certificat_payment_audits_certificat_id_idx" ON "certificat_payment_audits" ("certificat_id");
