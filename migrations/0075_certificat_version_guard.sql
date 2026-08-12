-- Task #451 (review round 3) — optimistic-concurrency version for certificats.
--
-- The issuance seal must freeze the exact financial inputs that produced the
-- pinned PDF. Every certificat UPDATE bumps `version`; the seal commits only
-- via `WHERE pdf_storage_key IS NULL AND version = <version captured before
-- rendering>`. If an operator PATCHes a financial field while the PDF is
-- rendering, the seal write misses and the sealer re-renders from the new
-- values — pinned bytes, issuance_snapshot and the persisted row can never
-- disagree.
ALTER TABLE "certificats" ADD COLUMN "version" integer NOT NULL DEFAULT 1;
