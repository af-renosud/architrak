-- Task #449 (review follow-up 2) — evidence integrity for Situation PDFs:
-- at most ONE situations row may carry a given source intake document.
-- Mirrors 0072's marche_documents constraint: concurrent attach requests
-- for the SAME parked intake document but DIFFERENT situations now race
-- through this partial unique index (the loser's transaction rolls back)
-- instead of retaining the same signed PDF on multiple situations.
-- Replaces the plain (non-unique) index from 0071.

DROP INDEX IF EXISTS "situations_source_intake_document_id_idx";

CREATE UNIQUE INDEX IF NOT EXISTS "situations_source_intake_doc_unique"
  ON "situations" ("source_intake_document_id")
  WHERE "source_intake_document_id" IS NOT NULL;
