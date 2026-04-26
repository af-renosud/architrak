-- Task #149 (AT1): Schema foundation for devis sign-off workflow per the
-- v1.0 inter-app contract with Archidoc and Archisign
-- (docs/INTER_APP_CONTRACT_v1.0.md, frozen 2026-04-25).
--
-- This migration is hand-authored (not drizzle-kit generated): the project
-- already mixes generated and hand-authored SQL files (e.g. 0022, 0023)
-- and there is no snapshot for those entries either, so we keep the
-- existing convention. The matching shared/schema.ts additions land in
-- the same task; the schema-presence sentinel artifact for this migration
-- is the new `client_checks` table (registered in
-- server/operations/schema-presence-check.ts MIGRATION_ARTIFACTS).
--
-- Decision recorded for AT1 step 2 (per task plan):
-- We add a NEW `webhook_events_in` table rather than extending the
-- existing generic `webhook_events` table. Reasons:
--   1. The contract uses the canonical `webhook_events_in` name across
--      sister apps (Archidoc AD1, Archisign AS1).
--   2. The new Archisign-receiver dedup space is logically distinct
--      from any pre-existing inbound webhook usage; namespacing avoids
--      cross-source collisions and keeps retention/cleanup decisions
--      (G14 deferred to v1.1) scoped per source.
--   3. The UNIQUE on `(source, event_id)` is shaped for the AT4
--      dedup-via-violation pattern (insert-first + ON CONFLICT DO
--      NOTHING short-circuit to `200 {deduplicated:true}`) and remains
--      future-proof if additional inbound sources are added.
--
-- The `signed_pdf_retention_breaches` table is parallel to (NOT shared
-- with) Archidoc's table per contract §2 footnote: disjoint envelope
-- sets (Architrak handles devis-derived envelopes only), no shared
-- rows. We include the `event_source` discriminator column for parity
-- with Archidoc's row shape even though only one value is meaningful
-- on the Architrak side today (`archisign`).

CREATE TABLE IF NOT EXISTS "client_checks" (
  "id" serial PRIMARY KEY NOT NULL,
  "devis_id" integer NOT NULL,
  "status" text DEFAULT 'open' NOT NULL,
  "query_text" text NOT NULL,
  "origin_source" text NOT NULL,
  "archisign_query_event_id" text,
  "resolved_by_source" text,
  "resolved_by_user_email" text,
  "resolved_by_actor" text,
  "resolution_note" text,
  "opened_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "resolved_at" timestamp with time zone,
  "created_by_user_id" integer,
  "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
  CONSTRAINT "client_checks_status_check" CHECK ("client_checks"."status" IN ('open', 'resolved', 'cancelled')),
  CONSTRAINT "client_checks_origin_source_check" CHECK ("client_checks"."origin_source" IN ('architrak_internal', 'archisign_query')),
  CONSTRAINT "client_checks_resolved_by_source_check" CHECK ("client_checks"."resolved_by_source" IS NULL OR "client_checks"."resolved_by_source" IN ('architrak_internal', 'archisign_admin_ui', 'external')),
  CONSTRAINT "client_checks_resolved_by_actor_check" CHECK ("client_checks"."resolved_by_actor" IS NULL OR "client_checks"."resolved_by_actor" IN ('architect', 'system'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "client_check_messages" (
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
  "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
  CONSTRAINT "client_check_messages_author_type_check" CHECK ("client_check_messages"."author_type" IN ('architect', 'client', 'system')),
  CONSTRAINT "client_check_messages_channel_check" CHECK ("client_check_messages"."channel" IN ('portal', 'email', 'system', 'archisign'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "client_check_tokens" (
  "id" serial PRIMARY KEY NOT NULL,
  "devis_id" integer NOT NULL,
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
CREATE TABLE IF NOT EXISTS "insurance_overrides" (
  "id" serial PRIMARY KEY NOT NULL,
  "devis_id" integer NOT NULL,
  "user_id" integer NOT NULL,
  "override_reason" text NOT NULL,
  "mirror_status_at_override" text NOT NULL,
  "mirror_synced_at_at_override" timestamp with time zone NOT NULL,
  "live_verdict_http_status" integer NOT NULL,
  "live_verdict_can_proceed" boolean,
  "live_verdict_response" jsonb,
  "overridden_by_user_email" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "signed_pdf_retention_breaches" (
  "id" serial PRIMARY KEY NOT NULL,
  "devis_id" integer NOT NULL,
  "archisign_envelope_id" text NOT NULL,
  "event_source" text DEFAULT 'archisign' NOT NULL,
  "original_signed_at" timestamp with time zone NOT NULL,
  "detected_at" timestamp with time zone NOT NULL,
  "incident_ref" text NOT NULL,
  "remediation_contact" text NOT NULL,
  "received_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "acknowledged_at" timestamp with time zone,
  "acknowledged_by_user_id" integer,
  CONSTRAINT "signed_pdf_retention_breaches_event_source_check" CHECK ("signed_pdf_retention_breaches"."event_source" IN ('archisign'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "webhook_deliveries_out" (
  "id" serial PRIMARY KEY NOT NULL,
  "event_id" text NOT NULL,
  "event_type" text NOT NULL,
  "target_url" text NOT NULL,
  "payload" jsonb NOT NULL,
  "state" text DEFAULT 'pending' NOT NULL,
  "attempt_count" integer DEFAULT 0 NOT NULL,
  "last_attempt_at" timestamp with time zone,
  "last_error_body" text,
  "next_attempt_at" timestamp with time zone,
  "succeeded_at" timestamp with time zone,
  "dead_lettered_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
  CONSTRAINT "webhook_deliveries_out_state_check" CHECK ("webhook_deliveries_out"."state" IN ('pending', 'succeeded', 'dead_lettered')),
  CONSTRAINT "webhook_deliveries_out_event_type_check" CHECK ("webhook_deliveries_out"."event_type" IN ('work_authorised', 'signed_pdf_retention_breach'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "webhook_events_in" (
  "id" serial PRIMARY KEY NOT NULL,
  "source" text NOT NULL,
  "event_id" text NOT NULL,
  "event_type" text NOT NULL,
  "payload_hash" text NOT NULL,
  "received_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
  CONSTRAINT "webhook_events_in_source_check" CHECK ("webhook_events_in"."source" IN ('archisign'))
);
--> statement-breakpoint
-- ADD CONSTRAINT statements wrapped in DO blocks so re-running this
-- migration by hand (recovery / replay) does not fail with
-- duplicate_object. drizzle's migrator never re-applies a tracked
-- migration, but operator runbooks (scripts/repair-migration-drift.mjs,
-- scripts/reconcile-drizzle-tracker.ts) replay SQL outside that path.
DO $$ BEGIN
  ALTER TABLE "client_checks" ADD CONSTRAINT "client_checks_devis_id_devis_id_fk" FOREIGN KEY ("devis_id") REFERENCES "public"."devis"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "client_checks" ADD CONSTRAINT "client_checks_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "client_check_messages" ADD CONSTRAINT "client_check_messages_check_id_client_checks_id_fk" FOREIGN KEY ("check_id") REFERENCES "public"."client_checks"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "client_check_messages" ADD CONSTRAINT "client_check_messages_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "client_check_tokens" ADD CONSTRAINT "client_check_tokens_devis_id_devis_id_fk" FOREIGN KEY ("devis_id") REFERENCES "public"."devis"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "client_check_tokens" ADD CONSTRAINT "client_check_tokens_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "insurance_overrides" ADD CONSTRAINT "insurance_overrides_devis_id_devis_id_fk" FOREIGN KEY ("devis_id") REFERENCES "public"."devis"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "insurance_overrides" ADD CONSTRAINT "insurance_overrides_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "signed_pdf_retention_breaches" ADD CONSTRAINT "signed_pdf_retention_breaches_devis_id_devis_id_fk" FOREIGN KEY ("devis_id") REFERENCES "public"."devis"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "signed_pdf_retention_breaches" ADD CONSTRAINT "signed_pdf_retention_breaches_acknowledged_by_user_id_users_id_fk" FOREIGN KEY ("acknowledged_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "client_checks_devis_id_idx" ON "client_checks" USING btree ("devis_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "client_checks_status_idx" ON "client_checks" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "client_checks_archisign_query_event_id_idx" ON "client_checks" USING btree ("archisign_query_event_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "client_check_messages_check_id_idx" ON "client_check_messages" USING btree ("check_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "client_check_tokens_token_hash_idx" ON "client_check_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "client_check_tokens_devis_id_idx" ON "client_check_tokens" USING btree ("devis_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "client_check_tokens_one_active_idx" ON "client_check_tokens" USING btree ("devis_id") WHERE "client_check_tokens"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "insurance_overrides_devis_id_idx" ON "insurance_overrides" USING btree ("devis_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "insurance_overrides_user_id_idx" ON "insurance_overrides" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "signed_pdf_retention_breaches_devis_id_idx" ON "signed_pdf_retention_breaches" USING btree ("devis_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "signed_pdf_retention_breaches_envelope_idx" ON "signed_pdf_retention_breaches" USING btree ("archisign_envelope_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "signed_pdf_retention_breaches_envelope_incident_unique" ON "signed_pdf_retention_breaches" USING btree ("archisign_envelope_id", "incident_ref");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "webhook_deliveries_out_event_id_unique" ON "webhook_deliveries_out" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "webhook_deliveries_out_state_idx" ON "webhook_deliveries_out" USING btree ("state");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "webhook_deliveries_out_state_next_attempt_idx" ON "webhook_deliveries_out" USING btree ("state", "next_attempt_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "webhook_deliveries_out_event_type_idx" ON "webhook_deliveries_out" USING btree ("event_type");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "webhook_events_in_source_event_id_unique" ON "webhook_events_in" USING btree ("source", "event_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "webhook_events_in_received_at_idx" ON "webhook_events_in" USING btree ("received_at");--> statement-breakpoint
ALTER TABLE "devis" ADD COLUMN IF NOT EXISTS "archidoc_dqe_export_id" text;--> statement-breakpoint
ALTER TABLE "devis" ADD COLUMN IF NOT EXISTS "archisign_envelope_id" text;--> statement-breakpoint
ALTER TABLE "devis" ADD COLUMN IF NOT EXISTS "identity_verification" jsonb;--> statement-breakpoint
ALTER TABLE "devis" ADD COLUMN IF NOT EXISTS "signed_pdf_fetch_url_snapshot" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "devis_archisign_envelope_id_idx" ON "devis" USING btree ("archisign_envelope_id");--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "client_contact_name" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "client_contact_email" text;
