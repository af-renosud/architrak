CREATE TABLE IF NOT EXISTS "quotation_rescrape_jobs" (
  "devis_id" integer PRIMARY KEY,
  "state" text NOT NULL DEFAULT 'pending',
  "owner" text,
  "attempts" integer NOT NULL DEFAULT 0,
  "message" text,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "quotation_rescrape_jobs_devis_id_devis_id_fk" FOREIGN KEY ("devis_id") REFERENCES "devis"("id") ON DELETE CASCADE
);
