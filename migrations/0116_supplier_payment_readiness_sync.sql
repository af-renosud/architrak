CREATE TABLE IF NOT EXISTS "archidoc_supplier_payment_readiness" (
	"supplier_archidoc_id" varchar(255) PRIMARY KEY NOT NULL,
	"partner_type" varchar(32) DEFAULT 'supplier' NOT NULL,
	"name" text NOT NULL,
	"siret" text,
	"address1" text,
	"address2" text,
	"town" text,
	"postcode" text,
	"country_code" varchar(2),
	"is_active" boolean NOT NULL,
	"primary_contact" jsonb,
	"banking" jsonb,
	"source_sequence" numeric(30, 0) NOT NULL,
	"payload_sha256" varchar(64) NOT NULL,
	"changed_at" timestamp with time zone NOT NULL,
	"supplier_updated_at" timestamp with time zone NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"source_base_url" text NOT NULL,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "archidoc_supplier_payment_readiness_partner_type_chk" CHECK ("archidoc_supplier_payment_readiness"."partner_type" = 'supplier'),
	CONSTRAINT "archidoc_supplier_payment_readiness_siret_chk" CHECK ("archidoc_supplier_payment_readiness"."siret" IS NULL OR "archidoc_supplier_payment_readiness"."siret" ~ '^[0-9]{14}$'),
	CONSTRAINT "archidoc_supplier_payment_readiness_country_chk" CHECK ("archidoc_supplier_payment_readiness"."country_code" IS NULL OR "archidoc_supplier_payment_readiness"."country_code" ~ '^[A-Z]{2}$'),
	CONSTRAINT "archidoc_supplier_payment_readiness_sequence_chk" CHECK ("archidoc_supplier_payment_readiness"."source_sequence" >= 0),
	CONSTRAINT "archidoc_supplier_payment_readiness_hash_chk" CHECK ("archidoc_supplier_payment_readiness"."payload_sha256" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "archidoc_supplier_payment_assignments" (
	"id" serial PRIMARY KEY NOT NULL,
	"supplier_archidoc_id" varchar(255) NOT NULL,
	"assignment_archidoc_id" varchar(255) NOT NULL,
	"project_archidoc_id" varchar(255) NOT NULL,
	"direct_payment_status" varchar(32) NOT NULL,
	"valid_from" date,
	"valid_until" date,
	"reason" text,
	"assignment_updated_at" timestamp with time zone NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	CONSTRAINT "archidoc_supplier_payment_assignments_upstream_unique" UNIQUE("assignment_archidoc_id"),
	CONSTRAINT "archidoc_supplier_payment_assignments_supplier_project_unique" UNIQUE("supplier_archidoc_id","project_archidoc_id"),
	CONSTRAINT "archidoc_supplier_payment_assignments_status_chk" CHECK ("archidoc_supplier_payment_assignments"."direct_payment_status" IN ('eligible', 'not_eligible', 'suspended')),
	CONSTRAINT "archidoc_supplier_payment_assignments_dates_chk" CHECK ("archidoc_supplier_payment_assignments"."valid_from" IS NULL OR "archidoc_supplier_payment_assignments"."valid_until" IS NULL OR "archidoc_supplier_payment_assignments"."valid_from" <= "archidoc_supplier_payment_assignments"."valid_until")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "archidoc_supplier_payment_cursor" (
	"singleton_key" integer DEFAULT 1 PRIMARY KEY NOT NULL,
	"contract_version" varchar(64) NOT NULL,
	"last_sequence" numeric(30, 0) NOT NULL,
	"minimum_available_sequence" numeric(30, 0) NOT NULL,
	"source_base_url" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "archidoc_supplier_payment_cursor_singleton_chk" CHECK ("archidoc_supplier_payment_cursor"."singleton_key" = 1),
	CONSTRAINT "archidoc_supplier_payment_cursor_sequence_chk" CHECK ("archidoc_supplier_payment_cursor"."last_sequence" >= 0 AND "archidoc_supplier_payment_cursor"."minimum_available_sequence" >= 0)
);
--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'archidoc_supplier_payment_assignments_supplier_archidoc_id_archidoc_supplier_payment_readiness_supplier_archidoc_id_fk'
	) THEN
		ALTER TABLE "archidoc_supplier_payment_assignments"
			ADD CONSTRAINT "archidoc_supplier_payment_assignments_supplier_archidoc_id_archidoc_supplier_payment_readiness_supplier_archidoc_id_fk"
			FOREIGN KEY ("supplier_archidoc_id")
			REFERENCES "public"."archidoc_supplier_payment_readiness"("supplier_archidoc_id")
			ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "archidoc_supplier_payment_readiness_active_idx" ON "archidoc_supplier_payment_readiness" USING btree ("is_deleted","is_active");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "archidoc_supplier_payment_assignments_supplier_idx" ON "archidoc_supplier_payment_assignments" USING btree ("supplier_archidoc_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "archidoc_supplier_payment_assignments_project_idx" ON "archidoc_supplier_payment_assignments" USING btree ("project_archidoc_id");