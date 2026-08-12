-- Task #457 — assisted reissue of sealed certificats.
--
-- A sealed certificat is immutable (Task #451); corrections happen by
-- reissuing it as a NEW draft certificat. `reissued_from_certificat_id`
-- records the lineage so the Document Chain can show both the superseded
-- original and its replacement. The partial unique index enforces "at most
-- one reissue per certificat" atomically at INSERT time, so two operators
-- clicking Reissue concurrently elect a single winner (no check-then-write).
ALTER TABLE "certificats" ADD COLUMN "reissued_from_certificat_id" integer;
--> statement-breakpoint
ALTER TABLE "certificats" ADD CONSTRAINT "certificats_reissued_from_fk"
  FOREIGN KEY ("reissued_from_certificat_id") REFERENCES "certificats"("id");
--> statement-breakpoint
CREATE UNIQUE INDEX "certificats_reissued_from_unique"
  ON "certificats" ("reissued_from_certificat_id")
  WHERE "reissued_from_certificat_id" IS NOT NULL;
