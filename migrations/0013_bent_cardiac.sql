CREATE TABLE "wish_list_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"type" text DEFAULT 'feature' NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "wish_list_items_type_chk" CHECK ("wish_list_items"."type" IN ('feature','bug')),
	CONSTRAINT "wish_list_items_status_chk" CHECK ("wish_list_items"."status" IN ('open','in_progress','done','wontfix'))
);
--> statement-breakpoint
CREATE INDEX "wish_list_items_status_idx" ON "wish_list_items" USING btree ("status");