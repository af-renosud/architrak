-- Task #175 — Design contract upload & extraction.
--
-- Adds two tables backing the New Project flow's PDF-driven replacement
-- for the manual conception/planning numeric fee inputs:
--
--   1. design_contracts        — one row per project (UNIQUE project_id).
--                                Stores the uploaded PDF's object storage
--                                key, AI-extracted totals (HT/TVA/TTC),
--                                and per-field confidence so the review
--                                modal can surface low-confidence values.
--   2. design_contract_milestones — ordered payment schedule, each row
--                                tied to a trigger event that maps to
--                                an existing Architrak lifecycle event
--                                (file_opened, concept_signed,
--                                 permit_deposited, final_plans_signed)
--                                or 'manual' for items the architect
--                                ticks off by hand.
--
-- One contract per project: re-upload archives the previous PDF (the
-- application moves the storage key under archive/ before the row is
-- replaced). A UNIQUE index on project_id enforces the invariant.

CREATE TABLE IF NOT EXISTS "design_contracts" (
  "id" serial PRIMARY KEY,
  "project_id" integer NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "storage_key" text NOT NULL,
  "original_filename" text NOT NULL,
  "total_ht" numeric(12, 2),
  "total_tva" numeric(12, 2),
  "total_ttc" numeric(12, 2) NOT NULL,
  "tva_rate" numeric(5, 2),
  "conception_amount_ht" numeric(12, 2),
  "planning_amount_ht" numeric(12, 2),
  "contract_date" date,
  "contract_reference" text,
  "extraction_confidence" jsonb,
  "extraction_warnings" jsonb,
  "uploaded_by_user_id" integer,
  "created_at" timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "design_contracts_total_ttc_nonneg" CHECK ("total_ttc" >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS "design_contracts_project_unique"
  ON "design_contracts" ("project_id");
CREATE INDEX IF NOT EXISTS "design_contracts_project_id_idx"
  ON "design_contracts" ("project_id");

CREATE TABLE IF NOT EXISTS "design_contract_milestones" (
  "id" serial PRIMARY KEY,
  "contract_id" integer NOT NULL REFERENCES "design_contracts"("id") ON DELETE CASCADE,
  "sequence" integer NOT NULL,
  "label_fr" text NOT NULL,
  "label_en" text,
  "percentage" numeric(5, 2) NOT NULL,
  "amount_ttc" numeric(12, 2) NOT NULL,
  "trigger_event" text NOT NULL DEFAULT 'manual',
  "status" text NOT NULL DEFAULT 'pending',
  "reached_at" timestamp,
  "invoiced_at" timestamp,
  "paid_at" timestamp,
  "notes" text,
  "reminder_last_sent_at" timestamp,
  "created_at" timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "design_contract_milestones_pct_range"
    CHECK ("percentage" >= 0 AND "percentage" <= 100),
  CONSTRAINT "design_contract_milestones_amount_nonneg"
    CHECK ("amount_ttc" >= 0),
  CONSTRAINT "design_contract_milestones_trigger_event_chk"
    CHECK ("trigger_event" IN (
      'file_opened','concept_signed','permit_deposited','final_plans_signed','manual'
    )),
  CONSTRAINT "design_contract_milestones_status_chk"
    CHECK ("status" IN ('pending','reached','invoiced','paid'))
);

CREATE INDEX IF NOT EXISTS "design_contract_milestones_contract_id_idx"
  ON "design_contract_milestones" ("contract_id");
CREATE INDEX IF NOT EXISTS "design_contract_milestones_status_idx"
  ON "design_contract_milestones" ("status");
CREATE UNIQUE INDEX IF NOT EXISTS "design_contract_milestones_contract_seq_unique"
  ON "design_contract_milestones" ("contract_id", "sequence");
