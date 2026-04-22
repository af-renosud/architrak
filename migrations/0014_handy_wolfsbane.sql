ALTER TABLE "contractors" DROP COLUMN "default_tva_rate";--> statement-breakpoint
ALTER TABLE "devis" DROP COLUMN "tva_rate";--> statement-breakpoint
ALTER TABLE "fees" DROP COLUMN "fee_amount_ttc";--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN "tva_rate";