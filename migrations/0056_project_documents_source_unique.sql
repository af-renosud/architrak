-- Task #312 — hard DB backstop for the Task #310 atomic claim.
--
-- Two app instances (or the manual "process" route racing the background
-- sweeper) must never file the same emailed attachment into
-- project_documents twice. The application-level guards
-- (claimEmailDocumentForProcessing + getProjectDocumentBySourceEmailDocumentId)
-- close the window in-process, but only a unique index makes the guarantee
-- hold across servers.
--
-- Step 1 — dedupe defensively before the index lands. If pre-#310 races
-- already produced duplicates, keep the OLDEST filing (the one operators
-- have been working with) and detach the provenance link on the later
-- copies instead of deleting rows — project documents may already be
-- referenced by Drive uploads or operator workflows, so destruction is
-- off the table. Detached duplicates keep their files and stay visible.
UPDATE project_documents
SET source_email_document_id = NULL,
    description = COALESCE(description, '') || ' [doublon détecté — lien e-mail retiré par la migration 0056]'
WHERE source_email_document_id IS NOT NULL
  AND id NOT IN (
    SELECT MIN(id)
    FROM project_documents
    WHERE source_email_document_id IS NOT NULL
    GROUP BY source_email_document_id
  );
--> statement-breakpoint

-- Step 2 — replace the plain lookup index with a partial UNIQUE index.
-- Partial (WHERE NOT NULL) because manually uploaded project documents have
-- no source email and must not collide with each other.
DROP INDEX IF EXISTS "project_documents_source_email_doc_idx";
--> statement-breakpoint
CREATE UNIQUE INDEX "project_documents_source_email_doc_idx"
  ON "project_documents" ("source_email_document_id")
  WHERE "source_email_document_id" IS NOT NULL;
