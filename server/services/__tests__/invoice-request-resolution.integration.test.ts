import { it, expect, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { projects, contractors, devis, invoices, feeEntries, fees, invoiceRequestDecisions,
  certificats, certificatArchitectInvoices, projectCommunications, pennylanePushes, certificatSources } from "@shared/schema";
import { resolveInvoiceRequest } from "../invoice-request-resolution.service";
import { approveInvoice } from "../invoice-approval.service";

it("corrects an approved unpaid invoice atomically and approves a separately reviewed mixed-tax invoice exactly once", async () => {
  const rollback = new Error("rollback isolated financial verification");
  const transaction = db.transaction.bind(db);
  await expect(transaction(async tx => {
    const [project] = await tx.insert(projects).values({
      name: "Isolated request decision", code: `RD-${Date.now()}`, clientName: "Test", feePercentage: "10",
    }).returning();
    const [contractor] = await tx.insert(contractors).values({ name: "Isolated request supplier" }).returning();
    const [quotation] = await tx.insert(devis).values({
      projectId: project.id, contractorId: contractor.id, devisCode: "RD", descriptionFr: "Test",
      amountHt: "63340", amountTtc: "69674",
    }).returning();
    const source = { documentType: "invoice", amountHt: 63340, amountTtc: 69674, netAPayer: 20902.2,
      tvaRate: 10, openingDepositEvidenceText: "FACTURE D'ACOMPTE DE 30 % TTC" };
    const [invoice] = await tx.insert(invoices).values({
      projectId: project.id, contractorId: contractor.id, devisId: quotation.id, invoiceNumber: "RD-approved",
      amountHt: "63340", amountTtc: "69674", tvaAmount: "6334", status: "approved", aiExtractedData: source,
    }).returning();
    const [fee] = await tx.insert(fees).values({ projectId: project.id, feeType: "works_percentage",
      baseAmountHt: "63340", feeRate: "10", feeAmountHt: "6334", remainingAmount: "6334" }).returning();
    await tx.insert(feeEntries).values({ feeId: fee.id, invoiceId: invoice.id, devisId: quotation.id,
      baseHt: "63340", feeRate: "10", feeAmount: "6334", status: "pending" });
    const [otherQuotation] = await tx.insert(devis).values({
      projectId: project.id, contractorId: contractor.id, devisCode: "OTHER", descriptionFr: "Unrelated",
      amountHt: "63340", amountTtc: "69674",
    }).returning();
    const [unrelated] = await tx.insert(certificats).values({
      projectId: project.id, contractorId: contractor.id, certificateRef: "C1",
      totalWorksHt: "19002", netToPayHt: "19002", tvaAmount: "1900.20", netToPayTtc: "20902.20",
      status: "draft", acompteDevisId: otherQuotation.id,
    }).returning();
    await tx.insert(certificatArchitectInvoices).values({ certificatId: unrelated.id,
      storageKey: "/test/unrelated.pdf", fileName: "unrelated.pdf" });
    await tx.insert(projectCommunications).values({ projectId: project.id, relatedCertificatId: unrelated.id,
      type: "general", recipientType: "client", subject: "Unrelated certificate", status: "sent" });
    await tx.insert(pennylanePushes).values({ projectId: project.id, kind: "customer_invoice", docId: -99999, state: "pending" });
    vi.spyOn(db, "transaction").mockImplementation((fn: any) => fn(tx));
    vi.spyOn(db, "select").mockImplementation((...args: any[]) => (tx.select as any)(...args));
    try {
      const preview: any = await resolveInvoiceRequest(invoice.id, "integration-test");
      expect(preview.certificates).toEqual([]);
      expect(preview.hasExternalInvoice).toBe(false);
      const result: any = await resolveInvoiceRequest(invoice.id, "integration-test", {
        expectedVersion: preview.expectedVersion, amountHt: 19002, amountTtc: 20902.2,
        reason: "The printed opening-deposit request is thirty percent TTC at ten percent TVA.",
      });
      expect(result.invoice).toMatchObject({ status: "approved", amountHt: "19002.00", amountTtc: "20902.20" });
      expect(await tx.select().from(feeEntries).where(eq(feeEntries.invoiceId, invoice.id)))
        .toMatchObject([{ baseHt: "19002.00", feeAmount: "1900.20" }]);
      expect(await tx.select().from(fees).where(eq(fees.id, fee.id)))
        .toMatchObject([{ feeAmountHt: "1900.20", remainingAmount: "1900.20" }]);
      const audit = await tx.select().from(invoiceRequestDecisions).where(eq(invoiceRequestDecisions.invoiceId, invoice.id));
      expect(audit).toHaveLength(1);
      expect(await tx.select().from(certificatSources).where(eq(certificatSources.certificatId, unrelated.id))).toEqual([]);
      expect(await tx.select().from(certificatArchitectInvoices).where(eq(certificatArchitectInvoices.certificatId, unrelated.id)))
        .toMatchObject([{ storageKey: "/test/unrelated.pdf" }]);
      const [ambiguous] = await tx.insert(certificats).values({
        projectId: project.id, contractorId: contractor.id, certificateRef: "C2",
        totalWorksHt: "19002", netToPayHt: "19002", tvaAmount: "1900.20", netToPayTtc: "20902.20", status: "draft",
      }).returning();
      const ambiguousPreview: any = await resolveInvoiceRequest(invoice.id, "integration-test");
      await expect(resolveInvoiceRequest(invoice.id, "integration-test", {
        expectedVersion: ambiguousPreview.expectedVersion, amountHt: 19002, amountTtc: 20902.2,
        reconcileCertificateId: ambiguous.id, reason: "An equal amount alone must never establish a documentary relationship.",
      })).rejects.toThrow("no proven");
      await tx.delete(certificats).where(eq(certificats.id, ambiguous.id));
      await expect(resolveInvoiceRequest(invoice.id, "integration-test", {
        expectedVersion: preview.expectedVersion, amountHt: 19002, amountTtc: 20902.2,
        reason: "This is deliberately stale and must not repeat the correction.",
      })).rejects.toThrow("changed");
      const [mixed] = await tx.insert(invoices).values({
        projectId: project.id, contractorId: contractor.id, devisId: quotation.id, invoiceNumber: "RD-mixed",
        amountHt: "63340", amountTtc: "69674", tvaAmount: "6334", status: "pending",
        aiExtractedData: { ...source, declaredTvaRates: [10, 20] },
      }).returning();
      expect((await approveInvoice(mixed.id)).status).toBe(409);
      const mixedPreview: any = await resolveInvoiceRequest(mixed.id, "integration-test");
      await resolveInvoiceRequest(mixed.id, "integration-test", {
        expectedVersion: mixedPreview.expectedVersion, amountHt: 21000, amountTtc: 23670,
        reason: "Reviewed the separate tax bases on the source document; two declared rates apply.",
      });
      expect((await approveInvoice(mixed.id)).success).toBe(true);
      expect((await approveInvoice(mixed.id)).success).toBe(true);
      const mixedEntries = await tx.select().from(feeEntries).where(eq(feeEntries.invoiceId, mixed.id));
      expect(mixedEntries).toHaveLength(1);
      expect(mixedEntries[0].feeAmount).toBe("2100.00");
      await tx.update(devis).set({ acompteRequired: true, acompteInvoiceId: mixed.id, acompteState: "invoiced" })
        .where(eq(devis.id, quotation.id));
      const linkedPreview: any = await resolveInvoiceRequest(invoice.id, "integration-test");
      await expect(resolveInvoiceRequest(invoice.id, "integration-test", {
        expectedVersion: linkedPreview.expectedVersion, amountHt: 19002, amountTtc: 20902.2,
        reason: "This correction must preserve the separately linked deposit invoice.",
      })).rejects.toThrow("separately linked");
      await tx.update(devis).set({ acompteInvoiceId: invoice.id, acompteState: "paid", acomptePaidAt: new Date() })
        .where(eq(devis.id, quotation.id));
      const paidPreview: any = await resolveInvoiceRequest(invoice.id, "integration-test");
      await expect(resolveInvoiceRequest(invoice.id, "integration-test", {
        expectedVersion: paidPreview.expectedVersion, amountHt: 19002, amountTtc: 20902.2,
        reason: "This correction must never reset the recorded deposit payment.",
      })).rejects.toThrow("paid");
      expect(await tx.select().from(devis).where(eq(devis.id, quotation.id)))
        .toMatchObject([{ acompteInvoiceId: invoice.id, acompteState: "paid" }]);
    } finally { vi.restoreAllMocks(); }
    throw rollback;
  })).rejects.toBe(rollback);
}, 30000);
