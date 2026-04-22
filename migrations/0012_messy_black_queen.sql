CREATE TABLE "archidoc_siret_issues" (
	"archidoc_id" varchar(255) PRIMARY KEY NOT NULL,
	"name" text,
	"raw_siret" text NOT NULL,
	"first_seen_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"last_seen_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"last_sync_log_id" integer
);
--> statement-breakpoint
ALTER TABLE "archidoc_sync_log" ADD COLUMN "malformed_siret_count" integer DEFAULT 0 NOT NULL;