import { afterAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { storage } from "../storage";
import { emailDocuments, projects, appSettings } from "@shared/schema";
import { evaluateFinancialPdf } from "../../shared/email-financial-gate";
vi.mock("../storage/object-storage", () => ({
  getDocumentBuffer: vi.fn(async () => Buffer.from("%PDF-1.7 original")),
  deleteDocument: vi.fn(),
}));
vi.mock("../gmail/financial-pdf-triage", async importOriginal => {
  const original = await importOriginal<typeof import("../gmail/financial-pdf-triage")>();
  return { ...original, triageFinancialPdf: async (_buffer: Buffer, _email: string, currentProjects: any[], previous: any) => ({
    ...previous, decision: evaluateFinancialPdf(previous.text, "", currentProjects),
  }) };
});
import { processEmailDocument } from "../gmail/document-parser";
import { discardIrrelevantEmailDocument } from "../services/irrelevant-email-cleanup";
import { deleteDocument } from "../storage/object-storage";
let projectId: number;
let documentId: number;
afterAll(async () => {
  if (documentId) await db.delete(emailDocuments).where(eq(emailDocuments.id, documentId));
  if (projectId) await db.delete(projects).where(eq(projects.id, projectId));
});
describe("admission survives archival and failed-extraction retry", () => {
  it("retains unlinked financial evidence and refuses row and object cleanup", async () => {
    const name = `AdmissionFixture ${Date.now()}`;
    const [project] = await db.insert(projects).values({ name, code: name, clientName: name }).returning();
    projectId = project.id;
    const text = `DEVIS 912\nClient: ${name}\nTotal TTC 1200`;
    const decision = evaluateFinancialPdf(text, "", [project]);
    expect(decision.status).toBe("eligible");
    const triage = { version: 4, text, method: "text", fingerprint: "retained-test", emailText: "", decision };
    const [doc] = await db.insert(emailDocuments).values({
      emailMessageId: name, emailReceivedAt: new Date(), extractionStatus: "failed",
      documentType: "unknown", attachmentFileName: "quotation.pdf",
      storageKey: `test-only/${name}.pdf`, extractedData: { financialTriage: triage },
    }).returning();
    documentId = doc.id;
    await db.update(projects).set({ archivedAt: new Date() }).where(eq(projects.id, projectId));
    await processEmailDocument(documentId);
    const retained = await storage.getEmailDocument(documentId);
    expect(retained?.extractionStatus).toBe("needs_review");
    expect((retained?.extractedData as any).financialTriage.decision.status).toBe("eligible");
    // Even a stale archived classification must not defeat the locked purge guard.
    await db.update(emailDocuments).set({ extractionStatus: "archived_project_candidate" }).where(eq(emailDocuments.id, documentId));
    expect(await discardIrrelevantEmailDocument(documentId)).toBe(false);
    expect(await storage.purgeSkippedEmailDocumentAtomically(documentId, undefined, false, true)).toBeNull();
    expect(await storage.getEmailDocument(documentId)).toBeDefined();
    const receipts = await db.select().from(appSettings).where(eq(appSettings.key, `irrelevant_pdf_cleanup:${documentId}`));
    expect(receipts).toHaveLength(0);
    expect(deleteDocument).not.toHaveBeenCalled();
  });
});
