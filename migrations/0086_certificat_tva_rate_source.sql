-- Task #479 — provenance of the TVA rate applied to a certificat.
-- Mixed-rate contractor invoices (10% + 20%) mean the applied rate can now
-- be a documentary blended effective rate derived from invoice HT/TTC, not
-- just a configured/statutory one. This column records WHICH source produced
-- tva_rate_percent: autoliquidation | override | documentary | marche |
-- contractor | default. Server-derived, frozen at seal.
ALTER TABLE "certificats" ADD COLUMN "tva_rate_source" text NOT NULL DEFAULT 'default';
--> statement-breakpoint
ALTER TABLE "certificats" ADD CONSTRAINT "certificats_tva_rate_source_check" CHECK ("tva_rate_source" IN ('autoliquidation', 'override', 'documentary', 'marche', 'contractor', 'default'));
