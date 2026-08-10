-- Task #388 — one shared client link per project with explicit publishing.
--
-- client_project_share_tokens: project-scoped share link (hashed token,
-- one active per project via partial unique index — mirrors
-- client_check_tokens conventions).
-- client_project_share_devis: explicit publish membership (token ↔ devis).
-- A devis is visible through the link ONLY when a membership row exists;
-- never auto-included. FKs indexed per ARCHITECTURE.md §2.2.1.

CREATE TABLE "client_project_share_tokens" (
  "id" serial PRIMARY KEY NOT NULL,
  "project_id" integer NOT NULL,
  "token_hash" text NOT NULL,
  "client_email" text NOT NULL,
  "client_name" text,
  "created_by_user_id" integer,
  "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "revoked_at" timestamp with time zone,
  "last_used_at" timestamp with time zone,
  "expires_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "client_project_share_tokens"
  ADD CONSTRAINT "client_project_share_tokens_project_id_projects_id_fk"
  FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "client_project_share_tokens"
  ADD CONSTRAINT "client_project_share_tokens_created_by_user_id_users_id_fk"
  FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "client_project_share_tokens_token_hash_idx" ON "client_project_share_tokens" ("token_hash");
--> statement-breakpoint
CREATE INDEX "client_project_share_tokens_project_id_idx" ON "client_project_share_tokens" ("project_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "client_project_share_tokens_one_active_idx" ON "client_project_share_tokens" ("project_id") WHERE "revoked_at" IS NULL;
--> statement-breakpoint
CREATE TABLE "client_project_share_devis" (
  "id" serial PRIMARY KEY NOT NULL,
  "token_id" integer NOT NULL,
  "devis_id" integer NOT NULL,
  "published_by_user_id" integer,
  "published_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
ALTER TABLE "client_project_share_devis"
  ADD CONSTRAINT "client_project_share_devis_token_id_client_project_share_tokens_id_fk"
  FOREIGN KEY ("token_id") REFERENCES "public"."client_project_share_tokens"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "client_project_share_devis"
  ADD CONSTRAINT "client_project_share_devis_devis_id_devis_id_fk"
  FOREIGN KEY ("devis_id") REFERENCES "public"."devis"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "client_project_share_devis"
  ADD CONSTRAINT "client_project_share_devis_published_by_user_id_users_id_fk"
  FOREIGN KEY ("published_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "client_project_share_devis_token_devis_idx" ON "client_project_share_devis" ("token_id", "devis_id");
--> statement-breakpoint
CREATE INDEX "client_project_share_devis_devis_id_idx" ON "client_project_share_devis" ("devis_id");
