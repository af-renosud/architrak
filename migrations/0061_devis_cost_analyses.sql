-- Task #378 — in-app AI cost-analysis appendix on outbound quotations.
--
-- One analysis per devis (unique FK). raw_text is the architect-editable
-- markdown (AI-generated or hand-edited); document is the server-parsed,
-- validated AST that the PDF serializer renders. Only status='confirmed'
-- analyses reach the PDF (draft → review/edit → confirm workflow).
-- revision implements optimistic concurrency like devis_line_contexts.
CREATE TABLE "devis_cost_analyses" (
  "id" serial PRIMARY KEY NOT NULL,
  "devis_id" integer NOT NULL UNIQUE REFERENCES "devis"("id") ON DELETE CASCADE,
  "raw_text" text NOT NULL,
  "document" jsonb NOT NULL,
  "warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "status" text DEFAULT 'draft' NOT NULL,
  "revision" integer DEFAULT 1 NOT NULL,
  "model_id" text,
  "prompt_version" integer,
  "generated_at" timestamp,
  "updated_by_email" text,
  "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
-- Task #378 — pin the exact PDF bytes Archisign fetches. Set at send time
-- to the generated combined/translated PDF storage key; the public fetch
-- route serves this key verbatim while an envelope exists, so a post-send
-- analysis/context edit can never change what the signer receives.
ALTER TABLE "devis" ADD COLUMN "archisign_pinned_pdf_storage_key" text;
