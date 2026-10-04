import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db, pool } from "../db";
import { storage } from "../storage";
import { projects, contractors, devis, devisLineItems, devisTranslations } from "@shared/schema";
import { commitTranslationApproval } from "../services/translation-approval-commit";
import { buildClientPortalPayload } from "../routes/public-client-checks";
import { confirmDevisAndMirror } from "../services/benchmark-ingest.service";

// Only uniquely named disposable rows. No PDFs, model calls, emails or signing.
const suffix = `approval-integrity-${Date.now()}-${Math.random().toString(36).slice(2)}`;
let projectId: number, contractorId: number, devisId: number;
const translated = { lineNumber: 1, originalDescription: "WIN 001, hors peinture.",
  translation: "WIN 001, painting excluded.", edited: false };
beforeAll(async () => {
  const [p] = await db.insert(projects).values({ name: suffix, code: suffix, clientName: "Fixture" }).returning();
  projectId = p.id;
  const [c] = await db.insert(contractors).values({ name: suffix }).returning();
  contractorId = c.id;
  const [d] = await db.insert(devis).values({ projectId, contractorId, devisCode: suffix,
    descriptionFr: "Disposable approval fixture", amountHt: "100", amountTtc: "120" }).returning();
  devisId = d.id;
  await db.insert(devisLineItems).values({ devisId, lineNumber: 1, description: translated.originalDescription,
    totalHt: "100", unitPriceHt: "100", quantity: "1" });
  await db.insert(devisTranslations).values({ devisId, status: "finalised", lineTranslations: [translated],
    approvedAt: new Date(), approvedBy: 999999, approvedByEmail: "fixture@local.test",
    translatedPdfStorageKey: "fixture-old", combinedPdfStorageKey: "fixture-old-combined", contextsVersion: 5 });
});
afterAll(async () => {
  if (devisId) {
    await db.delete(devisTranslations).where(eq(devisTranslations.devisId, devisId));
    await db.delete(devisLineItems).where(eq(devisLineItems.devisId, devisId));
    await db.delete(devis).where(eq(devis.id, devisId));
  }
  if (contractorId) await db.delete(contractors).where(eq(contractors.id, contractorId));
  if (projectId) await db.delete(projects).where(eq(projects.id, projectId));
  await pool.end();
});
const snapshot = async () => ({
  quotation: await storage.getDevis(devisId), lines: await storage.getDevisLineItems(devisId),
  translation: await storage.getDevisTranslation(devisId),
});
describe("exact-version translation approval", () => {
  it("a post-finalisation content edit atomically unpublishes approval and cached PDFs", async () => {
    const updated = await storage.updateDevisTranslation(devisId, {
      lineTranslations: [{ ...translated, translation: "WIN 001" }], status: "finalised",
    });
    expect(updated).toMatchObject({ status: "edited", approvedAt: null, approvedBy: null, approvedByEmail: null,
      translatedPdfStorageKey: null, combinedPdfStorageKey: null, contextsVersion: 6 });
    const portal = await buildClientPortalPayload((await storage.getDevis(devisId))!, null);
    expect(JSON.stringify(portal)).not.toContain('"translation":"WIN 001"');
    expect(JSON.stringify(portal)).not.toContain("painting excluded");
  });
  it("rejects a translation edit between coverage checking and approval commit", async () => {
    const prepared = await snapshot();
    await storage.updateDevisTranslation(devisId, { lineTranslations: [translated] });
    expect(await commitTranslationApproval(devisId, prepared, 999999, "fixture@local.test")).toBeNull();
    expect((await storage.getDevisTranslation(devisId))?.status).toBe("edited");
  });
  it("rejects a source change between coverage checking and approval commit", async () => {
    const prepared = await snapshot();
    await db.update(devisLineItems).set({ description: `${translated.originalDescription} Pose comprise.` })
      .where(eq(devisLineItems.devisId, devisId));
    expect(await commitTranslationApproval(devisId, prepared, 999999, "fixture@local.test")).toBeNull();
  });
  it("can commit an unchanged checked version", async () => {
    expect(await commitTranslationApproval(devisId, await snapshot(), 999999, "fixture@local.test"))
      .toMatchObject({ status: "finalised", approvedBy: 999999 });
  });
  it("confirmation revalidates working descriptions inside its transaction", async () => {
    const region = { page: 1, x: 0, y: 0.3, w: 1, h: 0.3 };
    const text = "WIN 001 Dim. L x H : 600 mm X 700 mm, hors peinture.";
    await db.update(devis).set({ status: "draft", aiExtractedData: {
      documentType: "quotation", extractionCoverage: { pdfPageCount: 1 },
      quotationVerification: { verified: true, manifest: {
        inventoriedPages: [1],
        sections: [{ id: "001", reference: "WIN 001", independentText: text, priceRegion: { ...region, y: 0.1, h: 0.01 },
          specificationRegions: [region], quantity: 1, unitPrice: 100, total: 100 }],
        segments: [{ id: "001", section: "001", page: 1, text, region, disposition: "item" }],
      } },
    } }).where(eq(devis.id, devisId));
    await db.update(devisLineItems).set({ description: text.replace(", hors peinture.", "") })
      .where(eq(devisLineItems.devisId, devisId));
    await expect(confirmDevisAndMirror(devisId, { status: "pending" })).rejects.toMatchObject({
      status: 409, code: "quotation_content_unverified",
    });
    expect((await storage.getDevis(devisId))?.status).toBe("draft");
  });
  it("confirmation rejects legacy illustrated evidence with no source verification", async () => {
    await db.update(devis).set({ aiExtractedData: {
      documentType: "quotation", illustratedRecovery: { status: "recovered", reason: "Legacy model response" },
    } }).where(eq(devis.id, devisId));
    await expect(confirmDevisAndMirror(devisId, { status: "pending" })).rejects.toMatchObject({
      status: 409, code: "quotation_content_unverified",
    });
    expect((await storage.getDevis(devisId))?.status).toBe("draft");
  });
});