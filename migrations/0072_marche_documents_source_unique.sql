-- Task #449 (review follow-up) — evidence integrity: at most ONE
-- marche_documents row per source intake document. Concurrent or
-- double-submitted attach requests race through ON CONFLICT DO NOTHING
-- against this partial unique index instead of creating duplicates.
-- Replaces the plain (non-unique) index from 0071.

DROP INDEX IF EXISTS "marche_documents_source_intake_document_id_idx";

CREATE UNIQUE INDEX IF NOT EXISTS "marche_documents_source_intake_doc_unique"
  ON "marche_documents" ("source_intake_document_id")
  WHERE "source_intake_document_id" IS NOT NULL;
