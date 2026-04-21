CREATE TABLE IF NOT EXISTS "lot_catalog" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"description_fr" text NOT NULL,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "lot_catalog_code_unique" UNIQUE("code")
);

--> statement-breakpoint
INSERT INTO "lot_catalog" ("code", "description_fr") VALUES
	('LOT0', 'PRESCRIPTIONS COMMUNES'),
	('TS', 'TERRASSEMENT'),
	('VRD', 'VOIRIES ET RÉSEAUX DIVERS'),
	('DM', 'DÉMOLITION'),
	('SO', 'SOUS OEUVRE'),
	('GO', 'GROS OEUVRE MAÇONNERIE'),
	('CH', 'CHARPENTE ET OSSATURE BOIS'),
	('CZ', 'COUVERTURE - ZINGUERIE'),
	('ET', 'ETUDES'),
	('EL', 'ÉLECTRICITÉ'),
	('PB', 'PLOMBERIE'),
	('PL', 'PLÂTRERIE'),
	('RM', 'CARRELAGE ET REVETEMENT MURAL'),
	('RS', 'REVETEMENT DE SOL (SAUF CARRELAGE)'),
	('MN', 'MENUISERIE'),
	('VT', 'VENTILATION'),
	('CL', 'CLIMATISATION'),
	('RP', 'RAVALEMENT PEINTURE'),
	('RE', 'REVÊTEMENTS EXTÉRIEURS'),
	('FN', 'FERRONNERIE/METALLERIE'),
	('AE', 'AMÉNAGEMENTS EXTÉRIEURS - ESPACES VERTS'),
	('PS', 'PISCINE'),
	('AR', 'ARCHITECT'),
	('FD', 'RAVALEMENT DE FACADE'),
	('FM', 'FUMISTERIE'),
	('GZ', 'INSTALLATIONS DE GAZ'),
	('JD', 'JURIDIQUE'),
	('KT', 'KITCHEN'),
	('MB', 'MARBRERIE'),
	('OO', 'INSTALLATION DE CHANTIER'),
	('PR', 'PROTECTION'),
	('CHP', 'DALLAGES ET CHAPES')
ON CONFLICT ("code") DO NOTHING;

--> statement-breakpoint
UPDATE "lots"
SET "description_fr" = c."description_fr"
FROM "lot_catalog" c
WHERE "lots"."lot_number" = c."code"
  AND "lots"."description_fr" <> c."description_fr";

--> statement-breakpoint
UPDATE "devis"
SET "lot_id" = NULL
WHERE "lot_id" IN (SELECT "id" FROM "lots" WHERE "lot_number" = '??');

--> statement-breakpoint
DELETE FROM "lots" WHERE "lot_number" = '??';
