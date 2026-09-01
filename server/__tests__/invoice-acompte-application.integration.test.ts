import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "../db";
import {
  acompteNoInvoicePayments,
  certificatPayments,
  certificats,
  contractors,
  devis,
  invoiceAcompteApplications,
  invoices,
  projectIntakeDocuments,
  projects,
  users,
} from "@shared/schema";
import {
  applyInvoiceAcompteDeduction,
  reconcilePaidAcompteFromCertificatLedger,
} from "../services/invoice-acompte-application.service";
import { getProjectFinancialSummary } from "../services/financial-summary.service";

let projectId: number;
let contractorId: number;
let devisId: number;
let certificatId: number;
let sourceId: number;
let invoiceId: number;

beforeAll(async () => {
  await db.insert(users).values({
    id: 1,
    googleId: "invoice-acompte-application-operator",
    email: "invoice-acompte-application@local.test",
  }).onConflictDoNothing();
  const [project] = await db.insert(projects).values({
    code: `IAA-${Date.now()}`,
    name: "Invoice opening-deposit application",
    clientName: "Test Client",
    status: "active",
  }).returning();
  projectId = project.id;
  const [contractor] = await db.insert(contractors).values({
    name: `Invoice acompte contractor ${Date.now()}`,
  }).returning();
  contractorId = contractor.id;
  const [devisRow] = await db.insert(devis).values({
    projectId,
    contractorId,
    devisCode: "RTBIM.1.TOPOGRAPHIQUE",
    descriptionFr: "Production arithmetic reproduction",
    amountHt: "2075.00",
    amountTtc: "2490.00",
    acompteRequired: true,
    acompteAmountHt: "1240.00",
    acompteState: "pending",
    signOffStage: "client_signed_off",
    accountingState: "active",
  }).returning();
  devisId = devisRow.id;
  const [certificat] = await db.insert(certificats).values({
    projectId,
    contractorId,
    certificateRef: `C-IAA-${Date.now()}`,
    dateIssued: "2026-08-16",
    totalWorksHt: "1240.00",
    pvMvAdjustment: "0.00",
    previousPayments: "0.00",
    retenueGarantie: "0.00",
    cumulativeProrataDeduction: "0.00",
    periodProrataDeduction: "0.00",
    cumulativeAcompteRecoupment: "0.00",
    periodAcompteRecoupment: "0.00",
    tvaRatePercent: "20.00",
    tvaAutoliquidation: false,
    tvaRateSource: "documentary",
    netToPayHt: "1240.00",
    tvaAmount: "248.00",
    netToPayTtc: "1488.00",
    acompteDevisId: devisId,
    status: "paid",
  }).returning();
  certificatId = certificat.id;
  await db.insert(certificatPayments).values({
    certificatId,
    datePaid: "2026-08-17",
    amount: "1488.00",
    reference: "LEDGER-IAA",
    loggedBy: "test",
  });
  const [source] = await db.insert(projectIntakeDocuments).values({
    projectId,
    fileName: "FR25.26-0144.pdf",
    storageKey: "tests/invoice-acompte/FR25.26-0144.pdf",
    contentFingerprint: "c".repeat(64),
    extractedData: {
      documentType: "invoice",
      amountHt: 2075,
      amountTtc: 2490,
      netAPayer: 1002,
      acomptePaidAmountTtc: 1488,
      acomptePaidEvidenceText: "Acompte versé 1 488,00 €",
    },
  }).returning();
  sourceId = source.id;
  const [invoice] = await db.insert(invoices).values({
    projectId,
    contractorId,
    devisId,
    sourceIntakeDocumentId: sourceId,
    invoiceNumber: "FR25.26-0144",
    amountHt: "2075.00",
    tvaAmount: "415.00",
    amountTtc: "2490.00",
    pdfPath: "tests/copied-invoice/FR25.26-0144.pdf",
  }).returning();
  invoiceId = invoice.id;
});

afterAll(async () => {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.allow_acompte_application_delete', 'true', true)`);
    await tx.delete(invoiceAcompteApplications).where(eq(invoiceAcompteApplications.devisId, devisId));
    await tx.execute(sql`SELECT set_config('app.allow_acompte_audit_delete', 'true', true)`);
    await tx.delete(acompteNoInvoicePayments).where(eq(acompteNoInvoicePayments.devisId, devisId));
  });
  await db.delete(invoices).where(eq(invoices.projectId, projectId));
  await db.delete(certificatPayments).where(eq(certificatPayments.certificatId, certificatId));
  await db.delete(certificats).where(eq(certificats.projectId, projectId));
  await db.delete(projectIntakeDocuments).where(eq(projectIntakeDocuments.projectId, projectId));
  await db.delete(devis).where(eq(devis.projectId, projectId));
  await db.delete(contractors).where(eq(contractors.id, contractorId));
  await db.delete(projects).where(eq(projects.id, projectId));
});

describe("invoice opening-deposit application", () => {
  it("reconciles a paid C1, applies exact invoice arithmetic once, and preserves conflicts", async () => {
    expect(await reconcilePaidAcompteFromCertificatLedger(devisId)).toBe(true);
    const [afterReconcile] = await db.select().from(devis).where(eq(devis.id, devisId));
    expect(afterReconcile.acompteState).toBe("paid");

    await db.insert(acompteNoInvoicePayments).values({
      devisId,
      certificatId,
      sourceIntakeDocumentId: sourceId,
      sourceStorageKey: "tests/invoice-acompte/FR25.26-0144.pdf",
      sourceFileName: "FR25.26-0144.pdf",
      sourceContentFingerprint: "c".repeat(64),
      amountHt: "1240.00",
      amountTtc: "1488.00",
      paidAt: new Date("2026-08-31T10:00:00.000Z"),
      paymentReference: "AUDIT-IAA",
      evidenceText: "Acompte versé 1 488,00 €",
      confirmedByUserId: 1,
    });

    const [first, replay] = await Promise.all([
      applyInvoiceAcompteDeduction(invoiceId),
      applyInvoiceAcompteDeduction(invoiceId),
    ]);
    expect(first.outcome).toBe("applied");
    expect(replay.outcome).toBe("applied");
    const rows = await db.select().from(invoiceAcompteApplications)
      .where(eq(invoiceAcompteApplications.invoiceId, invoiceId));
    expect(rows).toHaveLength(1);
    expect(rows[0].appliedTtc).toBe("1488.00");
    expect(rows[0].invoiceGrossTtc).toBe("2490.00");
    expect(rows[0].invoiceNetPayableTtc).toBe("1002.00");
    expect(rows[0].paymentConflict).toBe(true);

    const [afterApply] = await db.select().from(devis).where(eq(devis.id, devisId));
    expect(afterApply.acompteState).toBe("applied");
    const summary = await getProjectFinancialSummary(projectId);
    expect(summary.success).toBe(true);
    if (!summary.success) throw new Error("unreachable");
    const devisSummary = summary.data.devis.find((row) => row.devisId === devisId)!;
    expect(devisSummary.certifiedTtc).toBe(2490);
    expect(devisSummary.acompteAppliedTtc).toBe(1488);
    expect(devisSummary.currentInvoiceBalanceTtc).toBe(1002);
    expect(devisSummary.resteARealiserTtc).toBe(0);
    expect(devisSummary.acomptePaymentConflict).toBe(true);

    await expect(
      db.update(invoiceAcompteApplications)
        .set({ appliedTtc: "1.00" })
        .where(eq(invoiceAcompteApplications.invoiceId, invoiceId)),
    ).rejects.toThrow(/Failed query: update "invoice_acompte_applications"/);
  });

  it("leaves mismatched extracted deposit amounts for review", async () => {
    const [mismatchDevis] = await db.insert(devis).values({
      projectId,
      contractorId,
      devisCode: `IAA-MISMATCH-${Date.now()}`,
      descriptionFr: "Mismatch",
      amountHt: "2075.00",
      amountTtc: "2490.00",
      acompteRequired: true,
      acompteAmountHt: "1240.00",
      acompteState: "paid",
      signOffStage: "client_signed_off",
      accountingState: "active",
    }).returning();
    const [mismatchCert] = await db.insert(certificats).values({
      projectId, contractorId, certificateRef: `C-IAA-M-${Date.now()}`,
      dateIssued: "2026-08-16", totalWorksHt: "1240.00", pvMvAdjustment: "0.00",
      previousPayments: "0.00", retenueGarantie: "0.00",
      cumulativeProrataDeduction: "0.00", periodProrataDeduction: "0.00",
      cumulativeAcompteRecoupment: "0.00", periodAcompteRecoupment: "0.00",
      tvaRatePercent: "20.00", tvaAutoliquidation: false, tvaRateSource: "documentary",
      netToPayHt: "1240.00", tvaAmount: "248.00", netToPayTtc: "1488.00",
      acompteDevisId: mismatchDevis.id, status: "paid",
    }).returning();
    await db.insert(certificatPayments).values({
      certificatId: mismatchCert.id, datePaid: "2026-08-17", amount: "1488.00",
    });
    const [mismatchSource] = await db.insert(projectIntakeDocuments).values({
      projectId,
      fileName: "mismatch.pdf",
      storageKey: "tests/invoice-acompte/mismatch.pdf",
      contentFingerprint: "d".repeat(64),
      extractedData: {
        documentType: "invoice",
        acomptePaidAmountTtc: 1400,
        acomptePaidEvidenceText: "Acompte versé",
        netAPayer: 1090,
      },
    }).returning();
    const [mismatchInvoice] = await db.insert(invoices).values({
      projectId, contractorId, devisId: mismatchDevis.id,
      sourceIntakeDocumentId: mismatchSource.id,
      invoiceNumber: `IAA-M-${Date.now()}`,
      amountHt: "2075.00", tvaAmount: "415.00", amountTtc: "2490.00",
    }).returning();
    const result = await applyInvoiceAcompteDeduction(mismatchInvoice.id);
    expect(result).toMatchObject({ outcome: "needs_review", code: "acompte_evidence_mismatch" });
    const [after] = await db.select().from(devis).where(eq(devis.id, mismatchDevis.id));
    expect(after.acompteState).toBe("paid");
    expect(await db.select().from(invoiceAcompteApplications)
      .where(eq(invoiceAcompteApplications.devisId, mismatchDevis.id))).toHaveLength(0);
  });
});