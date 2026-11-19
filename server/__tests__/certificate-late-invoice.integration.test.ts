import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db, pool } from "../db";
import { projects, contractors, devis, invoices, certificats, certificatSources } from "@shared/schema";
import { existingCertificateInvoiceLink, lateInvoiceCandidateReason } from "../services/certificate-late-invoice.service";

const name = `late-link-${Date.now()}`;
let projectId: number, contractorId: number, devisId: number, invoiceId: number, certId: number;
beforeAll(async () => {
  const [p] = await db.insert(projects).values({ name, code: name, clientName: "Test" }).returning();
  projectId = p.id;
  const [c] = await db.insert(contractors).values({ name }).returning();
  contractorId = c.id;
  const [d] = await db.insert(devis).values({ projectId, contractorId, devisCode: name,
    descriptionFr: "Disposable fixture", amountHt: "4600", amountTtc: "5520" }).returning();
  devisId = d.id;
  const [i] = await db.insert(invoices).values({ projectId, contractorId, devisId,
    invoiceNumber: name, amountHt: "4600", tvaAmount: "920", amountTtc: "5520", status: "approved" }).returning();
  invoiceId = i.id;
  const [cert] = await db.insert(certificats).values({ projectId, contractorId, certificateRef: "C3",
    totalWorksHt: "4600", netToPayHt: "4600", tvaAmount: "920", netToPayTtc: "5520",
    status: "sent", pdfStorageKey: "test/immutable.pdf", issuedAt: new Date(),
    issuanceSnapshot: { sourceInvoiceIds: [], note: "original snapshot" } }).returning();
  certId = cert.id;
});
afterAll(async () => {
  if (projectId) await db.delete(projects).where(eq(projects.id, projectId));
  if (contractorId) await db.delete(contractors).where(eq(contractors.id, contractorId));
  await pool.end();
});
const get = async () => {
  const [invoice] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
  const [cert] = await db.select().from(certificats).where(eq(certificats.id, certId));
  return { invoice, cert };
};
const preview = async () => {
  const result = await existingCertificateInvoiceLink(invoiceId, "fixture");
  if (!("expectedVersion" in result)) throw new Error("Expected preview");
  return result;
};
describe("later invoice association with an issued certificate", () => {
  it("offers matching certificate and refuses mismatches, drafts and conflicting claims", async () => {
    const p = await preview();
    expect(p.candidates).toContainEqual(expect.objectContaining({ id: certId, reason: null }));
    const { invoice, cert } = await get();
    expect(lateInvoiceCandidateReason(invoice, { ...cert, netToPayTtc: "5519" }, false, false)).toMatch(/HT\/TTC/);
    expect(lateInvoiceCandidateReason(invoice, { ...cert, status: "superseded" }, false, false)).toMatch(/issued/);
    expect(lateInvoiceCandidateReason(invoice, { ...cert, pdfStorageKey: null }, false, false)).toMatch(/issued/);
    expect(lateInvoiceCandidateReason(invoice, { ...cert, projectId: -1 }, false, false)).toMatch(/project/);
    expect(lateInvoiceCandidateReason(invoice, { ...cert, tvaEvidenceDevisId: -1 }, false, false)).toMatch(/quotation/);
    expect(lateInvoiceCandidateReason(invoice, cert, true, false)).toMatch(/already linked/);
    expect(lateInvoiceCandidateReason(invoice, cert, false, true)).toMatch(/scope/);
  });
  it("refuses a stale comparison without a partial link", async () => {
    const p = await preview();
    await db.update(invoices).set({ notes: "changed after preview" }).where(eq(invoices.id, invoiceId));
    await expect(existingCertificateInvoiceLink(invoiceId, "fixture", {
      certificatId: certId, expectedVersion: p.expectedVersion!, confirmed: true, reason: "Reviewed matching invoice and original certificate.",
    })).rejects.toThrow(/changed/);
    expect(await db.select().from(certificatSources).where(eq(certificatSources.certificatId, certId))).toHaveLength(0);
  });
  it("atomically records one association, preserves every financial field and freezes invoice evidence", async () => {
    const before = await get(), p = await preview();
    const input = { certificatId: certId, expectedVersion: p.expectedVersion!, confirmed: true as const,
      reason: "Reviewed original certificate C3 and corresponding contractor invoice." };
    const results = await Promise.all([existingCertificateInvoiceLink(invoiceId, "fixture", input),
      existingCertificateInvoiceLink(invoiceId, "fixture", input)]);
    expect(results.every(r => "linked" in r && r.linked)).toBe(true);
    expect(await get()).toEqual(before);
    const sources = await db.select().from(certificatSources).where(and(
      eq(certificatSources.certificatId, certId), eq(certificatSources.invoiceId, invoiceId)));
    expect(sources).toHaveLength(1);
    expect(sources[0].lateAssociation).toMatchObject({ reason: input.reason, actor: "fixture", amountTtc: "5520.00" });
    await expect(db.update(invoices).set({ amountHt: "4500" }).where(eq(invoices.id, invoiceId))).rejects.toThrow();
    await expect(db.update(certificatSources).set({ lateAssociation: null }).where(eq(certificatSources.id, sources[0].id))).rejects.toThrow();
    expect((await preview()).candidates.find(c => c.id === certId)?.reason).toMatch(/already linked/);
  });
  it("refuses linking in archived projects", async () => {
    await db.update(projects).set({ archivedAt: new Date() }).where(eq(projects.id, projectId));
    await expect(preview()).rejects.toThrow(/archived/);
  });
});
