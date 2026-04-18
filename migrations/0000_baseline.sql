CREATE TABLE "ai_model_settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"task_type" text NOT NULL,
	"provider" text DEFAULT 'gemini' NOT NULL,
	"model_id" text DEFAULT 'gemini-2.0-flash' NOT NULL,
	"updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "ai_model_settings_task_type_unique" UNIQUE("task_type")
);
--> statement-breakpoint
CREATE TABLE "archidoc_contractors" (
	"archidoc_id" varchar(255) PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"siret" text,
	"address1" text,
	"address2" text,
	"town" text,
	"postcode" text,
	"office_phone" text,
	"website" text,
	"trade_ids" jsonb,
	"insurance_status" text,
	"decennale_insurer" text,
	"decennale_policy_number" text,
	"decennale_end_date" text,
	"rc_pro_insurer" text,
	"rc_pro_policy_number" text,
	"rc_pro_end_date" text,
	"special_conditions" text,
	"contacts" jsonb,
	"archidoc_updated_at" timestamp,
	"synced_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "archidoc_projects" (
	"archidoc_id" varchar(255) PRIMARY KEY NOT NULL,
	"project_name" text NOT NULL,
	"code" text,
	"client_name" text,
	"address" text,
	"status" text,
	"clients" jsonb,
	"lot_contractors" jsonb,
	"custom_lots" jsonb,
	"actors" jsonb,
	"is_deleted" boolean DEFAULT false,
	"archidoc_updated_at" timestamp,
	"synced_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "archidoc_proposal_fees" (
	"id" serial PRIMARY KEY NOT NULL,
	"archidoc_project_id" varchar(255) NOT NULL,
	"pro_service_ht" numeric(12, 2),
	"pro_service_tva" numeric(12, 2),
	"pro_service_ttc" numeric(12, 2),
	"planning_ht" numeric(12, 2),
	"planning_tva" numeric(12, 2),
	"planning_ttc" numeric(12, 2),
	"pm_percentage" numeric(5, 2),
	"pm_note" text,
	"synced_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "archidoc_proposal_fees_project_unique" UNIQUE("archidoc_project_id")
);
--> statement-breakpoint
CREATE TABLE "archidoc_sync_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"sync_type" text NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"completed_at" timestamp,
	"records_updated" integer DEFAULT 0,
	"error_message" text
);
--> statement-breakpoint
CREATE TABLE "archidoc_trades" (
	"archidoc_id" varchar(255) PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"description" text,
	"category" text,
	"sort_order" integer,
	"synced_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "avenants" (
	"id" serial PRIMARY KEY NOT NULL,
	"devis_id" integer NOT NULL,
	"avenant_number" text,
	"type" text NOT NULL,
	"description_fr" text NOT NULL,
	"description_uk" text,
	"amount_ht" numeric(12, 2) NOT NULL,
	"amount_ttc" numeric(12, 2) NOT NULL,
	"date_signed" date,
	"status" text DEFAULT 'draft' NOT NULL,
	"pvmv_ref" text,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "benchmark_documents" (
	"id" serial PRIMARY KEY NOT NULL,
	"source" text DEFAULT 'standalone' NOT NULL,
	"source_devis_id" integer,
	"contractor_id" integer,
	"external_contractor_name" text,
	"external_siret" text,
	"document_date" date,
	"notes" text,
	"pdf_storage_key" text,
	"pdf_file_name" text,
	"total_ht" numeric(12, 2),
	"ai_extracted_data" jsonb,
	"ai_confidence" integer,
	"validation_warnings" jsonb,
	"needs_review" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "benchmark_documents_source_devis_unique" UNIQUE("source_devis_id"),
	CONSTRAINT "benchmark_documents_contractor_identity_check" CHECK (("benchmark_documents"."contractor_id" IS NOT NULL) OR ("benchmark_documents"."external_contractor_name" IS NOT NULL AND length(trim("benchmark_documents"."external_contractor_name")) > 0))
);
--> statement-breakpoint
CREATE TABLE "benchmark_item_tags" (
	"item_id" integer NOT NULL,
	"tag_id" integer NOT NULL,
	CONSTRAINT "benchmark_item_tags_unique" UNIQUE("item_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "benchmark_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"document_id" integer NOT NULL,
	"line_number" integer NOT NULL,
	"description" text NOT NULL,
	"raw_quantity" numeric(12, 3),
	"raw_unit" text,
	"raw_unit_price_ht" numeric(12, 2),
	"raw_total_ht" numeric(12, 2),
	"normalized_unit" text,
	"normalized_unit_price_ht" numeric(12, 2),
	"ai_confidence" integer,
	"needs_review" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "benchmark_tags" (
	"id" serial PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"category" text,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "benchmark_tags_label_unique" UNIQUE("label")
);
--> statement-breakpoint
CREATE TABLE "certificats" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"contractor_id" integer NOT NULL,
	"certificate_ref" text NOT NULL,
	"date_issued" date,
	"total_works_ht" numeric(12, 2) NOT NULL,
	"pv_mv_adjustment" numeric(12, 2) DEFAULT '0.00',
	"previous_payments" numeric(12, 2) DEFAULT '0.00',
	"retenue_garantie" numeric(12, 2) DEFAULT '0.00',
	"net_to_pay_ht" numeric(12, 2) NOT NULL,
	"tva_amount" numeric(12, 2) NOT NULL,
	"net_to_pay_ttc" numeric(12, 2) NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"notes" text,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "certificats_project_ref_unique" UNIQUE("project_id","certificate_ref")
);
--> statement-breakpoint
CREATE TABLE "client_payment_evidence" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"invoice_id" integer,
	"certificat_id" integer,
	"uploaded_by_email" text,
	"storage_key" text NOT NULL,
	"file_name" text NOT NULL,
	"notes" text,
	"uploaded_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contractors" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"siret" text,
	"address" text,
	"email" text,
	"phone" text,
	"default_tva_rate" numeric(5, 2) DEFAULT '20.00',
	"notes" text,
	"archidoc_id" varchar(255),
	"contact_name" text,
	"contact_job_title" text,
	"contact_mobile" text,
	"town" text,
	"postcode" text,
	"website" text,
	"insurance_status" text,
	"decennale_insurer" text,
	"decennale_policy_number" text,
	"decennale_end_date" date,
	"rc_pro_insurer" text,
	"rc_pro_policy_number" text,
	"rc_pro_end_date" date,
	"special_conditions" text,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "contractors_archidoc_id_unique" UNIQUE("archidoc_id")
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "devis" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"contractor_id" integer NOT NULL,
	"lot_id" integer,
	"marche_id" integer,
	"devis_code" text NOT NULL,
	"devis_number" text,
	"ref2" text,
	"description_fr" text NOT NULL,
	"description_uk" text,
	"amount_ht" numeric(12, 2) NOT NULL,
	"tva_rate" numeric(5, 2) DEFAULT '20.00' NOT NULL,
	"amount_ttc" numeric(12, 2) NOT NULL,
	"invoicing_mode" text DEFAULT 'mode_a' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"sign_off_stage" text DEFAULT 'received' NOT NULL,
	"void_reason" text,
	"date_sent" date,
	"date_signed" date,
	"pvmv_ref" text,
	"pdf_storage_key" text,
	"pdf_file_name" text,
	"validation_warnings" jsonb,
	"ai_extracted_data" jsonb,
	"ai_confidence" integer,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "devis_line_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"devis_id" integer NOT NULL,
	"line_number" integer NOT NULL,
	"description" text NOT NULL,
	"quantity" numeric(12, 3),
	"unit" text,
	"unit_price_ht" numeric(12, 2),
	"total_ht" numeric(12, 2) NOT NULL,
	"percent_complete" numeric(5, 2) DEFAULT '0.00',
	"check_status" text DEFAULT 'unchecked' NOT NULL,
	"check_notes" text
);
--> statement-breakpoint
CREATE TABLE "document_advisories" (
	"id" serial PRIMARY KEY NOT NULL,
	"devis_id" integer,
	"invoice_id" integer,
	"code" text NOT NULL,
	"field" text,
	"severity" text NOT NULL,
	"message" text NOT NULL,
	"source" text DEFAULT 'extractor' NOT NULL,
	"raised_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"resolved_at" timestamp,
	"acknowledged_at" timestamp,
	"acknowledged_by" text,
	CONSTRAINT "document_advisories_subject_check" CHECK (("document_advisories"."devis_id" IS NOT NULL) <> ("document_advisories"."invoice_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "email_documents" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer,
	"email_message_id" text NOT NULL,
	"email_thread_id" text,
	"email_from" text,
	"email_subject" text,
	"email_received_at" timestamp,
	"email_link" text,
	"attachment_file_name" text,
	"storage_key" text,
	"document_type" text DEFAULT 'unknown' NOT NULL,
	"extraction_status" text DEFAULT 'pending' NOT NULL,
	"extracted_data" jsonb,
	"match_confidence" numeric(5, 2),
	"matched_fields" jsonb,
	"gmail_label_applied" boolean DEFAULT false NOT NULL,
	"contractor_id" integer,
	"devis_id" integer,
	"invoice_id" integer,
	"notes" text,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "email_documents_email_message_id_unique" UNIQUE("email_message_id")
);
--> statement-breakpoint
CREATE TABLE "fee_entries" (
	"id" serial PRIMARY KEY NOT NULL,
	"fee_id" integer NOT NULL,
	"invoice_id" integer,
	"devis_id" integer,
	"base_ht" numeric(12, 2) NOT NULL,
	"fee_rate" numeric(5, 2) NOT NULL,
	"fee_amount" numeric(12, 2) NOT NULL,
	"pennylane_invoice_ref" text,
	"date_invoiced" date,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "fee_entries_fee_amount_nonneg" CHECK ("fee_entries"."fee_amount" >= 0),
	CONSTRAINT "fee_entries_fee_rate_pct" CHECK ("fee_entries"."fee_rate" >= 0 AND "fee_entries"."fee_rate" <= 100)
);
--> statement-breakpoint
CREATE TABLE "fees" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"fee_type" text NOT NULL,
	"phase" text,
	"base_amount_ht" numeric(12, 2) DEFAULT '0.00' NOT NULL,
	"fee_rate" numeric(5, 2),
	"fee_amount_ht" numeric(12, 2) NOT NULL,
	"fee_amount_ttc" numeric(12, 2) NOT NULL,
	"invoiced_amount" numeric(12, 2) DEFAULT '0.00',
	"remaining_amount" numeric(12, 2) NOT NULL,
	"pennylane_ref" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" serial PRIMARY KEY NOT NULL,
	"devis_id" integer NOT NULL,
	"contractor_id" integer NOT NULL,
	"project_id" integer NOT NULL,
	"certificate_number" text,
	"invoice_number" text NOT NULL,
	"amount_ht" numeric(12, 2) NOT NULL,
	"tva_amount" numeric(12, 2) NOT NULL,
	"amount_ttc" numeric(12, 2) NOT NULL,
	"date_issued" date,
	"date_sent" date,
	"date_paid" date,
	"status" text DEFAULT 'pending' NOT NULL,
	"pdf_path" text,
	"notes" text,
	"validation_warnings" jsonb,
	"ai_extracted_data" jsonb,
	"ai_confidence" integer,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "invoices_amount_ht_nonneg" CHECK ("invoices"."amount_ht" >= 0),
	CONSTRAINT "invoices_amount_ttc_nonneg" CHECK ("invoices"."amount_ttc" >= 0),
	CONSTRAINT "invoices_tva_amount_nonneg" CHECK ("invoices"."tva_amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "lots" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"lot_number" text NOT NULL,
	"description_fr" text NOT NULL,
	"description_uk" text,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "lots_project_lot_unique" UNIQUE("project_id","lot_number")
);
--> statement-breakpoint
CREATE TABLE "marches" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"contractor_id" integer NOT NULL,
	"marche_number" text,
	"price_type" text DEFAULT 'forfaitaire' NOT NULL,
	"total_ht" numeric(12, 2) NOT NULL,
	"total_ttc" numeric(12, 2) NOT NULL,
	"retenue_garantie_percent" numeric(5, 2) DEFAULT '5.00',
	"payment_schedule" jsonb,
	"signed_date" date,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"conversation_id" integer NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_reminders" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"invoice_id" integer,
	"certificat_id" integer,
	"contractor_id" integer,
	"recipient_type" text NOT NULL,
	"recipient_email" text,
	"reminder_type" text NOT NULL,
	"scheduled_date" date NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"sent_at" timestamp,
	"response_received_at" timestamp,
	"notes" text,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_communications" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"type" text DEFAULT 'general' NOT NULL,
	"recipient_type" text NOT NULL,
	"recipient_email" text,
	"recipient_name" text,
	"subject" text NOT NULL,
	"body" text,
	"attachment_storage_keys" jsonb,
	"status" text DEFAULT 'draft' NOT NULL,
	"sent_at" timestamp,
	"email_message_id" text,
	"email_thread_id" text,
	"related_certificat_id" integer,
	"related_invoice_id" integer,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_documents" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"file_name" text NOT NULL,
	"storage_key" text NOT NULL,
	"document_type" text DEFAULT 'other' NOT NULL,
	"uploaded_by" text,
	"description" text,
	"source_email_document_id" integer,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"code" text NOT NULL,
	"client_name" text NOT NULL,
	"client_address" text,
	"site_address" text,
	"status" text DEFAULT 'active' NOT NULL,
	"tva_rate" numeric(5, 2) DEFAULT '20.00' NOT NULL,
	"fee_percentage" numeric(5, 2),
	"fee_type" text DEFAULT 'percentage' NOT NULL,
	"conception_fee" numeric(12, 2),
	"planning_fee" numeric(12, 2),
	"has_marche" boolean DEFAULT false NOT NULL,
	"archidoc_id" varchar(255),
	"archidoc_clients" jsonb,
	"last_synced_at" timestamp,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "projects_archidoc_id_unique" UNIQUE("archidoc_id")
);
--> statement-breakpoint
CREATE TABLE "session" (
	"sid" varchar PRIMARY KEY NOT NULL,
	"sess" jsonb NOT NULL,
	"expire" timestamp (6) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "situation_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"situation_id" integer NOT NULL,
	"devis_line_item_id" integer NOT NULL,
	"percent_complete" numeric(5, 2) NOT NULL,
	"cumulative_amount" numeric(12, 2) NOT NULL,
	"previous_amount" numeric(12, 2) DEFAULT '0.00' NOT NULL,
	"net_amount" numeric(12, 2) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "situations" (
	"id" serial PRIMARY KEY NOT NULL,
	"devis_id" integer NOT NULL,
	"invoice_id" integer,
	"situation_number" integer NOT NULL,
	"date_issued" date,
	"cumulative_ht" numeric(12, 2) NOT NULL,
	"previous_ht" numeric(12, 2) DEFAULT '0.00' NOT NULL,
	"net_ht" numeric(12, 2) NOT NULL,
	"retenue_garantie" numeric(12, 2) DEFAULT '0.00',
	"net_to_pay_ht" numeric(12, 2) NOT NULL,
	"tva_amount" numeric(12, 2) NOT NULL,
	"net_to_pay_ttc" numeric(12, 2) NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "situations_devis_number_unique" UNIQUE("devis_id","situation_number"),
	CONSTRAINT "situations_cumulative_ht_nonneg" CHECK ("situations"."cumulative_ht" >= 0),
	CONSTRAINT "situations_net_to_pay_ttc_nonneg" CHECK ("situations"."net_to_pay_ttc" >= 0)
);
--> statement-breakpoint
CREATE TABLE "template_assets" (
	"id" serial PRIMARY KEY NOT NULL,
	"asset_type" text NOT NULL,
	"file_name" text NOT NULL,
	"storage_key" text NOT NULL,
	"mime_type" text,
	"uploaded_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "template_assets_asset_type_unique" UNIQUE("asset_type")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"google_id" text NOT NULL,
	"email" text NOT NULL,
	"first_name" text,
	"last_name" text,
	"profile_image_url" text,
	"last_login_at" timestamp,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "users_google_id_unique" UNIQUE("google_id"),
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"event_id" text PRIMARY KEY NOT NULL,
	"event_type" text NOT NULL,
	"payload_hash" text NOT NULL,
	"processed_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
ALTER TABLE "avenants" ADD CONSTRAINT "avenants_devis_id_devis_id_fk" FOREIGN KEY ("devis_id") REFERENCES "public"."devis"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "benchmark_documents" ADD CONSTRAINT "benchmark_documents_source_devis_id_devis_id_fk" FOREIGN KEY ("source_devis_id") REFERENCES "public"."devis"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "benchmark_documents" ADD CONSTRAINT "benchmark_documents_contractor_id_contractors_id_fk" FOREIGN KEY ("contractor_id") REFERENCES "public"."contractors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "benchmark_item_tags" ADD CONSTRAINT "benchmark_item_tags_item_id_benchmark_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."benchmark_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "benchmark_item_tags" ADD CONSTRAINT "benchmark_item_tags_tag_id_benchmark_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."benchmark_tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "benchmark_items" ADD CONSTRAINT "benchmark_items_document_id_benchmark_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."benchmark_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "certificats" ADD CONSTRAINT "certificats_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "certificats" ADD CONSTRAINT "certificats_contractor_id_contractors_id_fk" FOREIGN KEY ("contractor_id") REFERENCES "public"."contractors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_payment_evidence" ADD CONSTRAINT "client_payment_evidence_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_payment_evidence" ADD CONSTRAINT "client_payment_evidence_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_payment_evidence" ADD CONSTRAINT "client_payment_evidence_certificat_id_certificats_id_fk" FOREIGN KEY ("certificat_id") REFERENCES "public"."certificats"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devis" ADD CONSTRAINT "devis_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devis" ADD CONSTRAINT "devis_contractor_id_contractors_id_fk" FOREIGN KEY ("contractor_id") REFERENCES "public"."contractors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devis" ADD CONSTRAINT "devis_lot_id_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."lots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devis" ADD CONSTRAINT "devis_marche_id_marches_id_fk" FOREIGN KEY ("marche_id") REFERENCES "public"."marches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devis_line_items" ADD CONSTRAINT "devis_line_items_devis_id_devis_id_fk" FOREIGN KEY ("devis_id") REFERENCES "public"."devis"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_advisories" ADD CONSTRAINT "document_advisories_devis_id_devis_id_fk" FOREIGN KEY ("devis_id") REFERENCES "public"."devis"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_advisories" ADD CONSTRAINT "document_advisories_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_documents" ADD CONSTRAINT "email_documents_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_documents" ADD CONSTRAINT "email_documents_contractor_id_contractors_id_fk" FOREIGN KEY ("contractor_id") REFERENCES "public"."contractors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_documents" ADD CONSTRAINT "email_documents_devis_id_devis_id_fk" FOREIGN KEY ("devis_id") REFERENCES "public"."devis"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_documents" ADD CONSTRAINT "email_documents_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_entries" ADD CONSTRAINT "fee_entries_fee_id_fees_id_fk" FOREIGN KEY ("fee_id") REFERENCES "public"."fees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_entries" ADD CONSTRAINT "fee_entries_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_entries" ADD CONSTRAINT "fee_entries_devis_id_devis_id_fk" FOREIGN KEY ("devis_id") REFERENCES "public"."devis"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fees" ADD CONSTRAINT "fees_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_devis_id_devis_id_fk" FOREIGN KEY ("devis_id") REFERENCES "public"."devis"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_contractor_id_contractors_id_fk" FOREIGN KEY ("contractor_id") REFERENCES "public"."contractors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lots" ADD CONSTRAINT "lots_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marches" ADD CONSTRAINT "marches_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marches" ADD CONSTRAINT "marches_contractor_id_contractors_id_fk" FOREIGN KEY ("contractor_id") REFERENCES "public"."contractors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_reminders" ADD CONSTRAINT "payment_reminders_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_reminders" ADD CONSTRAINT "payment_reminders_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_reminders" ADD CONSTRAINT "payment_reminders_certificat_id_certificats_id_fk" FOREIGN KEY ("certificat_id") REFERENCES "public"."certificats"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_reminders" ADD CONSTRAINT "payment_reminders_contractor_id_contractors_id_fk" FOREIGN KEY ("contractor_id") REFERENCES "public"."contractors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_communications" ADD CONSTRAINT "project_communications_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_communications" ADD CONSTRAINT "project_communications_related_certificat_id_certificats_id_fk" FOREIGN KEY ("related_certificat_id") REFERENCES "public"."certificats"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_communications" ADD CONSTRAINT "project_communications_related_invoice_id_invoices_id_fk" FOREIGN KEY ("related_invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_documents" ADD CONSTRAINT "project_documents_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_documents" ADD CONSTRAINT "project_documents_source_email_document_id_email_documents_id_fk" FOREIGN KEY ("source_email_document_id") REFERENCES "public"."email_documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "situation_lines" ADD CONSTRAINT "situation_lines_situation_id_situations_id_fk" FOREIGN KEY ("situation_id") REFERENCES "public"."situations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "situation_lines" ADD CONSTRAINT "situation_lines_devis_line_item_id_devis_line_items_id_fk" FOREIGN KEY ("devis_line_item_id") REFERENCES "public"."devis_line_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "situations" ADD CONSTRAINT "situations_devis_id_devis_id_fk" FOREIGN KEY ("devis_id") REFERENCES "public"."devis"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "situations" ADD CONSTRAINT "situations_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "avenants_devis_id_idx" ON "avenants" USING btree ("devis_id");--> statement-breakpoint
CREATE INDEX "benchmark_documents_contractor_idx" ON "benchmark_documents" USING btree ("contractor_id");--> statement-breakpoint
CREATE INDEX "benchmark_documents_date_idx" ON "benchmark_documents" USING btree ("document_date");--> statement-breakpoint
CREATE INDEX "benchmark_item_tags_tag_id_idx" ON "benchmark_item_tags" USING btree ("tag_id");--> statement-breakpoint
CREATE INDEX "benchmark_items_document_id_idx" ON "benchmark_items" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "benchmark_items_normalized_unit_idx" ON "benchmark_items" USING btree ("normalized_unit");--> statement-breakpoint
CREATE INDEX "benchmark_items_needs_review_idx" ON "benchmark_items" USING btree ("needs_review");--> statement-breakpoint
CREATE INDEX "certificats_project_contractor_idx" ON "certificats" USING btree ("project_id","contractor_id");--> statement-breakpoint
CREATE INDEX "client_payment_evidence_project_id_idx" ON "client_payment_evidence" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "devis_project_id_idx" ON "devis" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "devis_contractor_id_idx" ON "devis" USING btree ("contractor_id");--> statement-breakpoint
CREATE INDEX "devis_line_items_devis_id_idx" ON "devis_line_items" USING btree ("devis_id");--> statement-breakpoint
CREATE INDEX "document_advisories_devis_id_idx" ON "document_advisories" USING btree ("devis_id");--> statement-breakpoint
CREATE INDEX "document_advisories_invoice_id_idx" ON "document_advisories" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "document_advisories_devis_severity_idx" ON "document_advisories" USING btree ("devis_id","severity");--> statement-breakpoint
CREATE INDEX "document_advisories_invoice_severity_idx" ON "document_advisories" USING btree ("invoice_id","severity");--> statement-breakpoint
CREATE INDEX "document_advisories_code_idx" ON "document_advisories" USING btree ("code");--> statement-breakpoint
CREATE INDEX "email_documents_project_id_idx" ON "email_documents" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "email_documents_extraction_status_idx" ON "email_documents" USING btree ("extraction_status");--> statement-breakpoint
CREATE INDEX "fee_entries_fee_id_idx" ON "fee_entries" USING btree ("fee_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fee_entries_invoice_unique" ON "fee_entries" USING btree ("invoice_id") WHERE "fee_entries"."invoice_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "fees_project_id_idx" ON "fees" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "invoices_project_id_idx" ON "invoices" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "invoices_devis_id_idx" ON "invoices" USING btree ("devis_id");--> statement-breakpoint
CREATE INDEX "invoices_contractor_id_idx" ON "invoices" USING btree ("contractor_id");--> statement-breakpoint
CREATE INDEX "lots_project_id_idx" ON "lots" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "marches_project_id_idx" ON "marches" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "marches_contractor_id_idx" ON "marches" USING btree ("contractor_id");--> statement-breakpoint
CREATE INDEX "messages_conversation_id_idx" ON "messages" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "payment_reminders_project_id_idx" ON "payment_reminders" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "payment_reminders_status_date_idx" ON "payment_reminders" USING btree ("status","scheduled_date");--> statement-breakpoint
CREATE INDEX "project_communications_project_id_idx" ON "project_communications" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "project_documents_project_id_idx" ON "project_documents" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "project_documents_source_email_doc_idx" ON "project_documents" USING btree ("source_email_document_id");--> statement-breakpoint
CREATE INDEX "sessions_expire_idx" ON "session" USING btree ("expire");--> statement-breakpoint
CREATE INDEX "situation_lines_situation_id_idx" ON "situation_lines" USING btree ("situation_id");--> statement-breakpoint
CREATE INDEX "situation_lines_devis_line_item_id_idx" ON "situation_lines" USING btree ("devis_line_item_id");--> statement-breakpoint
CREATE INDEX "situations_devis_id_idx" ON "situations" USING btree ("devis_id");--> statement-breakpoint
CREATE INDEX "webhook_events_event_type_idx" ON "webhook_events" USING btree ("event_type");--> statement-breakpoint
CREATE INDEX "webhook_events_processed_at_idx" ON "webhook_events" USING btree ("processed_at");