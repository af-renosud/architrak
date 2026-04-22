CREATE TABLE "devis_check_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"check_id" integer NOT NULL,
	"author_type" text NOT NULL,
	"author_user_id" integer,
	"author_email" text,
	"author_name" text,
	"body" text NOT NULL,
	"channel" text DEFAULT 'portal' NOT NULL,
	"email_message_id" text,
	"email_thread_id" text,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "devis_check_messages_author_type_check" CHECK ("devis_check_messages"."author_type" IN ('architect', 'contractor', 'system')),
	CONSTRAINT "devis_check_messages_channel_check" CHECK ("devis_check_messages"."channel" IN ('portal', 'email', 'system'))
);
--> statement-breakpoint
CREATE TABLE "devis_check_tokens" (
	"id" serial PRIMARY KEY NOT NULL,
	"devis_id" integer NOT NULL,
	"token_hash" text NOT NULL,
	"contractor_id" integer NOT NULL,
	"contractor_email" text NOT NULL,
	"created_by_user_id" integer,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"revoked_at" timestamp,
	"last_used_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "devis_checks" (
	"id" serial PRIMARY KEY NOT NULL,
	"devis_id" integer NOT NULL,
	"origin" text NOT NULL,
	"line_item_id" integer,
	"status" text DEFAULT 'open' NOT NULL,
	"query" text NOT NULL,
	"resolution_note" text,
	"created_by_user_id" integer,
	"resolved_at" timestamp,
	"resolved_by_user_id" integer,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "devis_checks_origin_check" CHECK ("devis_checks"."origin" IN ('line_item', 'general')),
	CONSTRAINT "devis_checks_status_check" CHECK ("devis_checks"."status" IN ('open', 'awaiting_contractor', 'awaiting_architect', 'resolved', 'dropped'))
);
--> statement-breakpoint
ALTER TABLE "project_communications" ADD COLUMN "dedupe_key" text;--> statement-breakpoint
ALTER TABLE "devis_check_messages" ADD CONSTRAINT "devis_check_messages_check_id_devis_checks_id_fk" FOREIGN KEY ("check_id") REFERENCES "public"."devis_checks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devis_check_messages" ADD CONSTRAINT "devis_check_messages_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devis_check_tokens" ADD CONSTRAINT "devis_check_tokens_devis_id_devis_id_fk" FOREIGN KEY ("devis_id") REFERENCES "public"."devis"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devis_check_tokens" ADD CONSTRAINT "devis_check_tokens_contractor_id_contractors_id_fk" FOREIGN KEY ("contractor_id") REFERENCES "public"."contractors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devis_check_tokens" ADD CONSTRAINT "devis_check_tokens_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devis_checks" ADD CONSTRAINT "devis_checks_devis_id_devis_id_fk" FOREIGN KEY ("devis_id") REFERENCES "public"."devis"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devis_checks" ADD CONSTRAINT "devis_checks_line_item_id_devis_line_items_id_fk" FOREIGN KEY ("line_item_id") REFERENCES "public"."devis_line_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devis_checks" ADD CONSTRAINT "devis_checks_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devis_checks" ADD CONSTRAINT "devis_checks_resolved_by_user_id_users_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "devis_check_messages_check_id_idx" ON "devis_check_messages" USING btree ("check_id");--> statement-breakpoint
CREATE UNIQUE INDEX "devis_check_tokens_token_hash_idx" ON "devis_check_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "devis_check_tokens_devis_id_idx" ON "devis_check_tokens" USING btree ("devis_id");--> statement-breakpoint
CREATE UNIQUE INDEX "devis_check_tokens_one_active_idx" ON "devis_check_tokens" USING btree ("devis_id") WHERE "devis_check_tokens"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "devis_checks_devis_id_idx" ON "devis_checks" USING btree ("devis_id");--> statement-breakpoint
CREATE INDEX "devis_checks_status_idx" ON "devis_checks" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "devis_checks_line_item_unique_idx" ON "devis_checks" USING btree ("devis_id","line_item_id") WHERE "devis_checks"."origin" = 'line_item' AND "devis_checks"."line_item_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "project_communications_dedupe_key_idx" ON "project_communications" USING btree ("dedupe_key");