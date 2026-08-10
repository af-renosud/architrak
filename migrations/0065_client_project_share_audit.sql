-- Task #394 — append-only audit trail for project share link actions.
--
-- client_project_share_audit: one row per architect action on the project
-- share link (issue / rotate / extend / revoke / publish / unpublish).
-- Membership rows in client_project_share_devis are DELETEd on unpublish,
-- so this table is the only durable record of who removed a quotation from
-- the client's view and when. Rows are never updated or deleted by app
-- code; token/devis FKs are SET NULL so history survives referenced-row
-- deletion, and `detail` carries a human-readable snapshot for the UI.

CREATE TABLE "client_project_share_audit" (
  "id" serial PRIMARY KEY NOT NULL,
  "project_id" integer NOT NULL,
  "token_id" integer,
  "devis_id" integer,
  "action" text NOT NULL,
  "actor_user_id" integer,
  "detail" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
ALTER TABLE "client_project_share_audit"
  ADD CONSTRAINT "client_project_share_audit_project_id_projects_id_fk"
  FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "client_project_share_audit"
  ADD CONSTRAINT "client_project_share_audit_token_id_client_project_share_tokens_id_fk"
  FOREIGN KEY ("token_id") REFERENCES "public"."client_project_share_tokens"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "client_project_share_audit"
  ADD CONSTRAINT "client_project_share_audit_devis_id_devis_id_fk"
  FOREIGN KEY ("devis_id") REFERENCES "public"."devis"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "client_project_share_audit"
  ADD CONSTRAINT "client_project_share_audit_actor_user_id_users_id_fk"
  FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "client_project_share_audit_project_id_idx" ON "client_project_share_audit" ("project_id");
--> statement-breakpoint
CREATE INDEX "client_project_share_audit_token_id_idx" ON "client_project_share_audit" ("token_id");
--> statement-breakpoint
CREATE INDEX "client_project_share_audit_devis_id_idx" ON "client_project_share_audit" ("devis_id");
