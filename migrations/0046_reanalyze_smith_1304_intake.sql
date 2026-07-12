-- Data fix (Task #254): the SMITH (SAINT PONS DE MAUCHIENS) 1304 devis
-- (project_intake_documents id 2, project id 7) is parked in production
-- because the pre-Task-#253 rasteriser sent a truncated page image to
-- Gemini, which answered a permanent 400 ("Unable to process input
-- image"). The rasteriser fix ships in the same build as this migration,
-- so this one-shot reset re-queues that single document; the intake
-- sweeper then re-analyzes it with the fixed pipeline within a minute of
-- the first production boot after deploy.
--
-- Guarded three ways so it is a no-op everywhere else (including dev and
-- replay databases): the exact document id, the still-parked routing
-- state, and the opaque Gemini park note that only the old rasteriser
-- bug produced. Idempotent — once the document leaves "parked" the
-- WHERE clause never matches again.
WITH reset_doc AS (
  UPDATE "project_intake_documents"
     SET "analysis_state" = 'pending',
         "routing_state"  = 'unrouted',
         "updated_at"     = CURRENT_TIMESTAMP
   WHERE "id" = 2
     AND "routing_state" = 'parked'
     AND "notes" LIKE '%Unable to process input image%'
     AND "file_name" ILIKE '%SMITH%'
   RETURNING "id"
)
UPDATE "intake_jobs" j
   SET "state"           = 'pending',
       "attempts"        = 0,
       "last_error"      = NULL,
       "next_attempt_at" = CURRENT_TIMESTAMP,
       "updated_at"      = CURRENT_TIMESTAMP
  FROM reset_doc d
 WHERE j."intake_document_id" = d."id";--> statement-breakpoint
-- Safety net: if the queue row was somehow deleted, recreate it so the
-- sweeper can see the document. No-op when the row exists (unique
-- constraint) or when the reset above did not fire.
INSERT INTO "intake_jobs" ("intake_document_id")
SELECT "id"
  FROM "project_intake_documents"
 WHERE "id" = 2
   AND "analysis_state" = 'pending'
   AND "routing_state" = 'unrouted'
   AND "notes" LIKE '%Unable to process input image%'
   AND "file_name" ILIKE '%SMITH%'
ON CONFLICT ("intake_document_id") DO NOTHING;
