-- Task #688 — immutable, fingerprint-bound human resolution for labelled
-- project identities which automatic exact matching correctly parks.
CREATE TABLE IF NOT EXISTS "intake_project_identity_resolutions" (
  "id" serial PRIMARY KEY NOT NULL,
  "intake_document_id" integer NOT NULL,
  "project_id" integer NOT NULL,
  "source_storage_key" text NOT NULL,
  "source_file_name" text NOT NULL,
  "source_content_fingerprint" text NOT NULL,
  "labelled_project_name" text,
  "labelled_project_reference" text,
  "confirmed_by_user_id" integer NOT NULL,
  "confirmed_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
  CONSTRAINT "intake_project_identity_resolutions_document_fk" FOREIGN KEY ("intake_document_id") REFERENCES "project_intake_documents"("id") ON DELETE RESTRICT,
  CONSTRAINT "intake_project_identity_resolutions_project_fk" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT,
  CONSTRAINT "intake_project_identity_resolutions_confirmed_by_user_fk" FOREIGN KEY ("confirmed_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT,
  CONSTRAINT "intake_project_identity_resolutions_label_check" CHECK ("labelled_project_name" IS NOT NULL OR "labelled_project_reference" IS NOT NULL)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "intake_project_identity_resolutions_document_fingerprint_unique"
  ON "intake_project_identity_resolutions" ("intake_document_id", "source_content_fingerprint");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "intake_project_identity_resolutions_project_id_idx"
  ON "intake_project_identity_resolutions" ("project_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "intake_project_identity_resolutions_confirmed_by_user_id_idx"
  ON "intake_project_identity_resolutions" ("confirmed_by_user_id");--> statement-breakpoint
CREATE OR REPLACE FUNCTION prevent_intake_project_identity_resolution_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('app.allow_intake_project_identity_resolution_delete', true) = 'true' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'intake_project_identity_resolutions rows are immutable';
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS intake_project_identity_resolutions_immutable_trg ON intake_project_identity_resolutions;--> statement-breakpoint
CREATE TRIGGER intake_project_identity_resolutions_immutable_trg
BEFORE UPDATE OR DELETE ON intake_project_identity_resolutions
FOR EACH ROW EXECUTE FUNCTION prevent_intake_project_identity_resolution_mutation();