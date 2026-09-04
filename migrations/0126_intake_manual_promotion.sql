ALTER TABLE "devis"
  ADD COLUMN IF NOT EXISTS "source_intake_document_id" integer;
ALTER TABLE "devis"
  ADD COLUMN IF NOT EXISTS "manual_intake_review_required" boolean DEFAULT false NOT NULL;
ALTER TABLE "devis"
  ADD COLUMN IF NOT EXISTS "manual_intake_reviewed_at" timestamp with time zone;
ALTER TABLE "devis"
  ADD COLUMN IF NOT EXISTS "manual_intake_reviewed_by_user_id" integer;

ALTER TABLE "invoices"
  ADD COLUMN IF NOT EXISTS "manual_intake_review_required" boolean DEFAULT false NOT NULL;
ALTER TABLE "invoices"
  ADD COLUMN IF NOT EXISTS "manual_intake_reviewed_at" timestamp with time zone;
ALTER TABLE "invoices"
  ADD COLUMN IF NOT EXISTS "manual_intake_reviewed_by_user_id" integer;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'devis_source_intake_document_id_project_intake_documents_id_fk') THEN
    ALTER TABLE "devis"
      ADD CONSTRAINT "devis_source_intake_document_id_project_intake_documents_id_fk"
      FOREIGN KEY ("source_intake_document_id") REFERENCES "public"."project_intake_documents"("id")
      ON DELETE RESTRICT ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'devis_manual_intake_reviewed_by_user_id_users_id_fk') THEN
    ALTER TABLE "devis"
      ADD CONSTRAINT "devis_manual_intake_reviewed_by_user_id_users_id_fk"
      FOREIGN KEY ("manual_intake_reviewed_by_user_id") REFERENCES "public"."users"("id")
      ON DELETE RESTRICT ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoices_manual_intake_reviewed_by_user_id_users_id_fk') THEN
    ALTER TABLE "invoices"
      ADD CONSTRAINT "invoices_manual_intake_reviewed_by_user_id_users_id_fk"
      FOREIGN KEY ("manual_intake_reviewed_by_user_id") REFERENCES "public"."users"("id")
      ON DELETE RESTRICT ON UPDATE NO ACTION;
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS "devis_source_intake_document_unique"
  ON "devis" USING btree ("source_intake_document_id")
  WHERE "source_intake_document_id" IS NOT NULL;

CREATE TABLE IF NOT EXISTS "intake_manual_promotions" (
  "id" serial PRIMARY KEY NOT NULL,
  "intake_document_id" integer NOT NULL,
  "project_id" integer NOT NULL,
  "source_storage_key" text NOT NULL,
  "source_file_name" text NOT NULL,
  "source_content_fingerprint" text NOT NULL,
  "prior_analysis_state" text NOT NULL,
  "prior_routing_state" text NOT NULL,
  "prior_park_reason" text NOT NULL,
  "promoted_kind" text NOT NULL,
  "promoted_id" integer NOT NULL,
  "contractor_id" integer NOT NULL,
  "target_devis_id" integer,
  "operator_note" text NOT NULL,
  "confirmed_by_user_id" integer NOT NULL,
  "confirmed_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'intake_manual_promotions_kind_check') THEN
    ALTER TABLE "intake_manual_promotions"
      ADD CONSTRAINT "intake_manual_promotions_kind_check"
      CHECK ("promoted_kind" IN ('devis', 'invoice'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'intake_manual_promotions_target_check') THEN
    ALTER TABLE "intake_manual_promotions"
      ADD CONSTRAINT "intake_manual_promotions_target_check"
      CHECK (
        ("promoted_kind" = 'devis' AND "target_devis_id" IS NULL)
        OR ("promoted_kind" = 'invoice' AND "target_devis_id" IS NOT NULL)
      );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'intake_manual_promotions_note_check') THEN
    ALTER TABLE "intake_manual_promotions"
      ADD CONSTRAINT "intake_manual_promotions_note_check"
      CHECK (length(btrim("operator_note")) >= 10);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'intake_manual_promotions_intake_document_id_project_intake_documents_id_fk') THEN
    ALTER TABLE "intake_manual_promotions"
      ADD CONSTRAINT "intake_manual_promotions_intake_document_id_project_intake_documents_id_fk"
      FOREIGN KEY ("intake_document_id") REFERENCES "public"."project_intake_documents"("id")
      ON DELETE RESTRICT ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'intake_manual_promotions_project_id_projects_id_fk') THEN
    ALTER TABLE "intake_manual_promotions"
      ADD CONSTRAINT "intake_manual_promotions_project_id_projects_id_fk"
      FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id")
      ON DELETE RESTRICT ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'intake_manual_promotions_contractor_id_contractors_id_fk') THEN
    ALTER TABLE "intake_manual_promotions"
      ADD CONSTRAINT "intake_manual_promotions_contractor_id_contractors_id_fk"
      FOREIGN KEY ("contractor_id") REFERENCES "public"."contractors"("id")
      ON DELETE RESTRICT ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'intake_manual_promotions_target_devis_id_devis_id_fk') THEN
    ALTER TABLE "intake_manual_promotions"
      ADD CONSTRAINT "intake_manual_promotions_target_devis_id_devis_id_fk"
      FOREIGN KEY ("target_devis_id") REFERENCES "public"."devis"("id")
      ON DELETE RESTRICT ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'intake_manual_promotions_confirmed_by_user_id_users_id_fk') THEN
    ALTER TABLE "intake_manual_promotions"
      ADD CONSTRAINT "intake_manual_promotions_confirmed_by_user_id_users_id_fk"
      FOREIGN KEY ("confirmed_by_user_id") REFERENCES "public"."users"("id")
      ON DELETE RESTRICT ON UPDATE NO ACTION;
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS "intake_manual_promotions_intake_document_unique"
  ON "intake_manual_promotions" USING btree ("intake_document_id");
CREATE INDEX IF NOT EXISTS "intake_manual_promotions_project_id_idx"
  ON "intake_manual_promotions" USING btree ("project_id");
CREATE INDEX IF NOT EXISTS "intake_manual_promotions_confirmed_by_user_id_idx"
  ON "intake_manual_promotions" USING btree ("confirmed_by_user_id");

CREATE OR REPLACE FUNCTION prevent_intake_manual_promotion_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('app.allow_intake_manual_promotion_delete', true) = 'true' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'intake_manual_promotions rows are immutable';
END;
$$;

DROP TRIGGER IF EXISTS intake_manual_promotions_immutable_trg ON "intake_manual_promotions";
CREATE TRIGGER intake_manual_promotions_immutable_trg
  BEFORE UPDATE OR DELETE ON "intake_manual_promotions"
  FOR EACH ROW EXECUTE FUNCTION prevent_intake_manual_promotion_mutation();

CREATE OR REPLACE FUNCTION prevent_devis_intake_source_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.source_intake_document_id IS DISTINCT FROM NEW.source_intake_document_id THEN
    RAISE EXCEPTION 'devis source_intake_document_id is immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS devis_intake_source_immutable_trg ON "devis";
CREATE TRIGGER devis_intake_source_immutable_trg
  BEFORE UPDATE OF source_intake_document_id ON "devis"
  FOR EACH ROW EXECUTE FUNCTION prevent_devis_intake_source_mutation();