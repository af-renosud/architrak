-- Task #389 — per-line dialogue entry points in the client portal.
--
-- A client question ("Ask about this") can now reference the specific devis
-- line item it concerns. Nullable: quotation-level questions and all
-- historical rows carry NULL. ON DELETE SET NULL — if a line is removed
-- (rescrape replaces lines wholesale) the question must survive as a
-- quotation-level thread rather than vanish with the line.
ALTER TABLE "client_checks" ADD COLUMN "devis_line_item_id" integer REFERENCES "devis_line_items"("id") ON DELETE SET NULL;
CREATE INDEX "client_checks_devis_line_item_id_idx" ON "client_checks" ("devis_line_item_id");
