-- Task #491 — one-click acompte (opening/deposit) certificat WITHOUT a
-- supplier invoice.
--
-- certificats.acompte_devis_id: non-null marks the row as an acompte
-- certificat raised straight from a signed devis. Acompte certificats sit
-- OUTSIDE the progress waterfall (the deductions resolver skips them when
-- reading prior cumulatives; the seal never re-resolves their money).
-- At most one live (non-superseded) acompte certificat per devis.
--
-- devis.acompte_paid_via: provenance of the 'paid' transition —
-- 'invoice' (facture d'acompte path) or 'certificat_no_invoice'
-- (no supplier invoice ever existed). Null until paid.
ALTER TABLE "certificats" ADD COLUMN "acompte_devis_id" integer;
--> statement-breakpoint
ALTER TABLE "certificats" ADD CONSTRAINT "certificats_acompte_devis_fk" FOREIGN KEY ("acompte_devis_id") REFERENCES "devis"("id");
--> statement-breakpoint
CREATE UNIQUE INDEX "certificats_acompte_devis_unique" ON "certificats" ("acompte_devis_id") WHERE "acompte_devis_id" IS NOT NULL AND "status" <> 'superseded';
--> statement-breakpoint
ALTER TABLE "devis" ADD COLUMN "acompte_paid_via" text;
--> statement-breakpoint
ALTER TABLE "devis" ADD CONSTRAINT "devis_acompte_paid_via_check" CHECK ("acompte_paid_via" IS NULL OR "acompte_paid_via" IN ('invoice', 'certificat_no_invoice'));
