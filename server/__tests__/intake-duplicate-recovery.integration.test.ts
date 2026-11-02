import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import { projects, contractors, users, devis, invoices, projectIntakeDocuments, intakeManualPromotions, projectDocuments, intakeJobs } from "@shared/schema";
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF");
const fingerprint = createHash("sha256").update(PDF).digest("hex");
vi.mock("../storage/object-storage", async original => ({ ...await original<typeof import("../storage/object-storage")>(), getDocumentBuffer: vi.fn(async () => PDF) }));
vi.mock("../services/devis-translation", () => ({ triggerDevisTranslation: vi.fn() }));
vi.mock("../services/reconciliation/reconciliation-queue.service", () => ({ enqueueReconciliation: vi.fn() }));
vi.mock("../services/advisory-reconciler", () => ({ reconcileAdvisories: vi.fn() }));
vi.mock("../services/drive/upload-queue.service", () => ({ enqueueDriveUpload: vi.fn() }));
import { listIntakeDuplicates, recoverIntakeDuplicate } from "../services/intake/duplicate-recovery.service";

let actor: number, contractor: number;
const projectIds: number[] = [];
beforeAll(async () => {
  const stamp = `${Date.now()}-${Math.random()}`;
  [actor] = (await db.insert(users).values({ googleId: `dup-${stamp}`, email: `dup-${stamp}@example.test` }).returning()).map(r => r.id);
  [contractor] = (await db.insert(contractors).values({ name: `Duplicate fixture ${stamp}` }).returning()).map(r => r.id);
});
async function fixture(status = "void", unpromoted = false) {
  const [project] = await db.insert(projects).values({ name: "Duplicate recovery test", code: `DUP-${Date.now()}-${Math.random()}`, clientName: "Fixture" }).returning();
  projectIds.push(project.id);
  const extraction = { documentType: "quotation", devisNumber: "260304", contractorName: "Fixture", amountHt: 100, amountTtc: 120, lineItems: [] };
  const [target] = await db.insert(devis).values({
    projectId: project.id, contractorId: contractor, devisCode: "260304", devisNumber: "260304", descriptionFr: "Original quotation",
    status, amountHt: "100", amountTtc: "120", aiExtractedData: extraction,
  }).returning();
  const [original] = await db.insert(projectIntakeDocuments).values({
    projectId: project.id, fileName: "original.pdf", storageKey: "tests/dup/original.pdf", contentFingerprint: fingerprint,
    analysisState: "analyzed", routingState: unpromoted ? "parked" : "routed", extractedData: extraction,
    promotedKind: unpromoted ? null : "devis", promotedId: unpromoted ? null : target.id,
  }).returning();
  const [duplicate] = await db.insert(projectIntakeDocuments).values({
    projectId: project.id, fileName: "duplicate.pdf", storageKey: "tests/dup/duplicate.pdf", contentFingerprint: fingerprint,
    analysisState: "analyzed", routingState: "duplicate", extractedData: { duplicateOfIntakeDocumentId: original.id },
  }).returning();
  return { project, original, duplicate, target };
}
afterAll(async () => {
  if (projectIds.length) {
    await db.transaction(async tx => {
      await tx.execute(sql`SELECT set_config('app.allow_intake_manual_promotion_delete', 'true', true)`);
      await tx.delete(intakeManualPromotions).where(inArray(intakeManualPromotions.projectId, projectIds));
    });
    await db.delete(invoices).where(inArray(invoices.projectId, projectIds));
    await db.delete(devis).where(inArray(devis.projectId, projectIds));
    await db.delete(projectDocuments).where(inArray(projectDocuments.projectId, projectIds));
    await db.delete(projectIntakeDocuments).where(inArray(projectIntakeDocuments.projectId, projectIds));
    await db.delete(projects).where(inArray(projects.id, projectIds));
  }
  await db.delete(contractors).where(eq(contractors.id, contractor));
  await db.delete(users).where(eq(users.id, actor));
});
describe("actionable duplicate recovery", () => {
  it("resolves the reported void-devis chain and atomically creates one reviewed draft", async () => {
    const f = await fixture();
    const [s] = await listIntakeDuplicates(f.project.id);
    expect(s).toMatchObject({ lifecycle: "historical", recovery: "draft", originalId: f.original.id });
    expect(s.href).toContain(`devis=${f.target.id}&includeVoid=true`);
    const result = await recoverIntakeDuplicate(f.duplicate.id, s.version, actor);
    const repeated = await recoverIntakeDuplicate(f.duplicate.id, s.version, actor);
    expect(repeated.id).toBe(result.id);
    const rows = await db.select().from(devis).where(eq(devis.projectId, f.project.id));
    expect(rows).toHaveLength(2);
    expect(rows.find(r => r.id === f.target.id)?.status).toBe("void");
    expect(rows.find(r => r.id === result.id)).toMatchObject({ status: "draft", manualIntakeReviewRequired: true, sourceIntakeDocumentId: f.duplicate.id });
    expect((await db.select().from(intakeManualPromotions).where(eq(intakeManualPromotions.intakeDocumentId, f.duplicate.id)))).toHaveLength(1);
  });
  it("refuses live duplicates, changed previews, archived projects, and linked financial records", async () => {
    const live = await fixture("draft");
    expect((await listIntakeDuplicates(live.project.id))[0]).toMatchObject({ lifecycle: "active", recovery: null });
    const changed = await fixture();
    const [preview] = await listIntakeDuplicates(changed.project.id);
    await db.update(devis).set({ status: "draft" }).where(eq(devis.id, changed.target.id));
    await expect(recoverIntakeDuplicate(changed.duplicate.id, preview.version, actor)).rejects.toThrow();
    const archived = await fixture();
    await db.update(projects).set({ archivedAt: new Date() }).where(eq(projects.id, archived.project.id));
    expect((await listIntakeDuplicates(archived.project.id))[0].recovery).toBeNull();
    const linked = await fixture();
    await db.insert(invoices).values({ projectId: linked.project.id, devisId: linked.target.id, contractorId: contractor, invoiceNumber: "F1", amountHt: "10", amountTtc: "12", tvaAmount: "2" });
    expect((await listIntakeDuplicates(linked.project.id))[0].blockedReason).toContain("financial");
  });
  it("serializes two different duplicate copies against one original", async () => {
    const f = await fixture();
    const [other] = await db.insert(projectIntakeDocuments).values({
      projectId: f.project.id, fileName: "second-copy.pdf", storageKey: "tests/dup/second.pdf", contentFingerprint: fingerprint,
      analysisState: "analyzed", routingState: "duplicate", extractedData: { duplicateOfIntakeDocumentId: f.original.id },
    }).returning();
    const previews = await listIntakeDuplicates(f.project.id);
    const attempts = await Promise.allSettled([f.duplicate, other].map(d =>
      recoverIntakeDuplicate(d.id, previews.find(p => p.intakeId === d.id)!.version, actor)));
    expect(attempts.filter(a => a.status === "fulfilled")).toHaveLength(1);
    expect((await db.select().from(devis).where(eq(devis.projectId, f.project.id)))).toHaveLength(2);
  });
  it("resumes the canonical original with a durable queue job, not the duplicate copy", async () => {
    const f = await fixture("void", true);
    const [s] = await listIntakeDuplicates(f.project.id);
    expect(s.recovery).toBe("resume");
    const result = await recoverIntakeDuplicate(f.duplicate.id, s.version, actor);
    expect(result).toMatchObject({ kind: "intake", id: f.original.id });
    expect((await db.select().from(intakeJobs).where(eq(intakeJobs.intakeDocumentId, f.original.id)))[0].state).toBe("pending");
    expect((await listIntakeDuplicates(f.project.id))[0].blockedReason).toContain("already processing");
  });
  it("fails closed for cycles and missing/cross-project targets; links direct record duplicates", async () => {
    const f = await fixture();
    await db.update(projectIntakeDocuments).set({ extractedData: { duplicateOfIntakeDocumentId: f.duplicate.id } }).where(eq(projectIntakeDocuments.id, f.original.id));
    expect((await listIntakeDuplicates(f.project.id)).find(s => s.intakeId === f.duplicate.id)?.lifecycle).toBe("missing");
    await db.update(projectIntakeDocuments).set({ extractedData: { duplicateOfDevisId: f.target.id } }).where(eq(projectIntakeDocuments.id, f.duplicate.id));
    expect((await listIntakeDuplicates(f.project.id)).find(s => s.intakeId === f.duplicate.id)?.href).toContain(`devis=${f.target.id}`);
    const other = await fixture();
    await db.update(projectIntakeDocuments).set({ extractedData: { duplicateOfDevisId: other.target.id } }).where(eq(projectIntakeDocuments.id, f.duplicate.id));
    expect((await listIntakeDuplicates(f.project.id)).find(s => s.intakeId === f.duplicate.id)?.href).toBeNull();
  });
  it("does not offer recovery for same-reference possible revisions", async () => {
    const f = await fixture();
    await db.update(projectIntakeDocuments).set({ routingState: "parked", extractedData: { possibleDuplicateOfDevisId: f.target.id } }).where(eq(projectIntakeDocuments.id, f.duplicate.id));
    expect((await listIntakeDuplicates(f.project.id))[0]).toMatchObject({ match: "possible", recovery: null });
    await db.update(projectIntakeDocuments).set({ extractedData: {}, notes: `Possible duplicate — review before routing: same number as existing devis 260304 (#${f.target.id}) but a different HT amount (incoming 200 € vs existing 100 €). Could be a revision.` }).where(eq(projectIntakeDocuments.id, f.duplicate.id));
    expect((await listIntakeDuplicates(f.project.id))[0]).toMatchObject({ match: "possible", recovery: null, lifecycle: "historical" });
  });
  it("recovers a void invoice only onto its active parent devis", async () => {
    const f = await fixture("draft", true);
    const [invoice] = await db.insert(invoices).values({
      projectId: f.project.id, devisId: f.target.id, contractorId: contractor, invoiceNumber: "F-RECOVER",
      amountHt: "100", amountTtc: "120", tvaAmount: "20", status: "void",
      aiExtractedData: { documentType: "invoice", invoiceNumber: "F-RECOVER", amountHt: 100, amountTtc: 120 },
    }).returning();
    await db.update(projectIntakeDocuments).set({ routingState: "routed", promotedKind: "invoice", promotedId: invoice.id,
      extractedData: { documentType: "invoice", invoiceNumber: "F-RECOVER", amountHt: 100, amountTtc: 120 },
    }).where(eq(projectIntakeDocuments.id, f.original.id));
    const [s] = await listIntakeDuplicates(f.project.id);
    expect(s.recovery).toBe("draft");
    const result = await recoverIntakeDuplicate(f.duplicate.id, s.version, actor);
    expect(result.kind).toBe("invoice");
    const [fresh] = await db.select().from(invoices).where(eq(invoices.id, result.id));
    expect(fresh).toMatchObject({ status: "draft", devisId: f.target.id, manualIntakeReviewRequired: true });
  });
  it("rejects signed historical quotations and preserved source-byte changes", async () => {
    const signed = await fixture();
    await db.update(devis).set({ dateSigned: "2026-01-01" }).where(eq(devis.id, signed.target.id));
    expect((await listIntakeDuplicates(signed.project.id))[0].recovery).toBeNull();
    const mismatch = await fixture();
    await db.update(projectIntakeDocuments).set({ contentFingerprint: "a".repeat(64) }).where(eq(projectIntakeDocuments.id, mismatch.duplicate.id));
    const [s] = await listIntakeDuplicates(mismatch.project.id);
    await expect(recoverIntakeDuplicate(mismatch.duplicate.id, s.version, actor)).rejects.toThrow("changed");
  });
});
