import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import http from "http";
import express from "express";
import type { AddressInfo } from "net";
import { db } from "../db";
import {
  certificats,
  certificatSources,
  projects,
  contractors,
  marches,
  devis,
  invoices,
  invoiceAcompteApplications,
  projectIntakeDocuments,
  situations,
} from "@shared/schema";
import { eq, inArray, sql } from "drizzle-orm";
import certificatsRouter from "../routes/certificats";
import { errorHandler } from "../middleware/error-handler";

/**
 * Task #496 — one-click certificat from a contractor invoice:
 *
 *  - preview + create derive everything server-side (Mode A: invoice HT;
 *    Mode B: linked situation's cumulative − previous), body is ignored.
 *  - previous payments come from the prior certificat chain (previousPayments
 *    + netToPayHt of the latest prior), excluding superseded and acompte certs.
 *  - the invoice→certificat link is written at creation; a second create for
 *    the same invoice is refused (409 INVOICE_ALREADY_CERTIFIED), concurrent
 *    double-clicks included.
 *  - guards: acompte facture refused, void devis refused, unknown invoice 404.
 */

vi.mock("../auth/middleware", () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

let projectId: number;
let contractorId: number;
let devisAId: number;
let devisBId: number;
let server: http.Server;
let base: string;

async function post(path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
async function get(path: string) {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
async function patch(path: string, body: unknown) {
  const res = await fetch(`${base}${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function insertInvoice(devisId: number, num: string, ht: string, ttc: string) {
  const [inv] = await db
    .insert(invoices)
    .values({ devisId, contractorId, projectId, invoiceNumber: num, amountHt: ht, tvaAmount: "0.00", amountTtc: ttc, status: "approved" })
    .returning();
  return inv;
}

beforeAll(async () => {
  const [p] = await db
    .insert(projects)
    .values({ code: `T496-${Date.now()}`, name: "Cert from invoice test", clientName: "Test Client", status: "active" })
    .returning();
  projectId = p.id;
  // Task #612 — the creation endpoint now requires an IBAN; seed one so the
  // existing test scenarios (create, double-click, concurrent) can proceed.
  const [c] = await db.insert(contractors).values({ name: `T496 Contractor ${Date.now()}`, iban: "FR7630006000011234567890189" }).returning();
  contractorId = c.id;
  await db.insert(marches).values({
    projectId,
    contractorId,
    totalHt: "20000.00",
    totalTtc: "24000.00",
    retenueGarantiePercent: "5.00",
  });
  const [dA] = await db
    .insert(devis)
    .values({
      projectId,
      contractorId,
      devisCode: "T496.A",
      descriptionFr: "Devis mode A",
      amountHt: "10000.00",
      amountTtc: "12000.00",
      signOffStage: "client_signed_off",
      status: "confirmed",
    })
    .returning();
  devisAId = dA.id;
  const [dB] = await db
    .insert(devis)
    .values({
      projectId,
      contractorId,
      devisCode: "T496.B",
      descriptionFr: "Devis mode B",
      amountHt: "10000.00",
      amountTtc: "12000.00",
      signOffStage: "client_signed_off",
      status: "confirmed",
    })
    .returning();
  devisBId = dB.id;

  const app = express();
  app.use(express.json());
  app.use(certificatsRouter);
  app.use(errorHandler);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const certRows = await db.select({ id: certificats.id }).from(certificats).where(eq(certificats.projectId, projectId));
  if (certRows.length) {
    await db.delete(certificatSources).where(inArray(certificatSources.certificatId, certRows.map((r) => r.id)));
  }
  await db.delete(certificats).where(eq(certificats.projectId, projectId));
  await db.delete(situations).where(inArray(situations.devisId, [devisAId, devisBId]));
  await db.delete(invoices).where(eq(invoices.projectId, projectId));
  await db.delete(marches).where(eq(marches.projectId, projectId));
  await db.delete(devis).where(eq(devis.projectId, projectId));
  await db.delete(contractors).where(eq(contractors.id, contractorId));
  await db.delete(projects).where(eq(projects.id, projectId));
});

describe("Task #496 — one-click certificat from invoice", () => {
  const manualCertificateBody = (manualContractorId: number) => ({
    contractorId: manualContractorId,
    contextDevisId: devisAId,
    dateIssued: "2026-09-09",
    totalWorksAmount: "4600.00",
    totalWorksAmountBasis: "ht",
    pvMvAdjustment: "0.00",
    previousPayments: "0.00",
    status: "draft",
    notes: "Manual certificate validation regression",
  });

  it("rejects the unselected contractor placeholder before any database insert", async () => {
    const response = await post(
      `/api/projects/${projectId}/certificats`,
      manualCertificateBody(0),
    );

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("VALIDATION_ERROR");
    expect(response.body.issues).toContainEqual({
      path: "contractorId",
      message: "Sélectionnez une entreprise.",
    });
  });

  it("returns a clear 404 for a contractor that does not exist", async () => {
    const response = await post(
      `/api/projects/${projectId}/certificats`,
      manualCertificateBody(999_999_999),
    );

    expect(response.status).toBe(404);
    expect(response.body.code).toBe("CONTRACTOR_NOT_FOUND");
    expect(response.body.message).toContain("entreprise valide");
  });

  it("rejects a forged reference and preserves server-only sequential allocation", async () => {
    const next = await get(`/api/projects/${projectId}/certificats/next-ref`);
    expect(next.status).toBe(200);

    const forged = await post(
      `/api/projects/${projectId}/certificats`,
      {
        ...manualCertificateBody(contractorId),
        certificateRef: "C999999",
      },
    );
    expect(forged.status).toBe(400);
    expect(forged.body.code).toBe("CERTIFICATE_REFERENCE_SERVER_MANAGED");

    const created = await post(
      `/api/projects/${projectId}/certificats`,
      manualCertificateBody(contractorId),
    );
    expect(created.status).toBe(201);
    expect(created.body.certificateRef).toBe(next.body.nextRef);

    try {
      const patched = await patch(
        `/api/certificats/${created.body.id}`,
        { certificateRef: "C999999" },
      );
      expect(patched.status).toBe(400);
      expect(patched.body.code).toBe("CERTIFICATE_REFERENCE_SERVER_MANAGED");

      const [stored] = await db
        .select({ certificateRef: certificats.certificateRef })
        .from(certificats)
        .where(eq(certificats.id, created.body.id));
      expect(stored.certificateRef).toBe(next.body.nextRef);
    } finally {
      await db.delete(certificats).where(eq(certificats.id, created.body.id));
    }
  });

  it("creates a manual certificate only when the signed quotation has no eligible invoice source", async () => {
    const response = await post(
      `/api/projects/${projectId}/certificats`,
      {
        ...manualCertificateBody(contractorId),
        contextDevisId: devisAId,
      },
    );

    expect(response.status).toBe(201);
    expect(response.body.contractorId).toBe(contractorId);
    await db.delete(certificats).where(eq(certificats.id, response.body.id));
  });

  it("refuses the manual fallback when an approved unpaid source is available", async () => {
    const invoice = await insertInvoice(
      devisAId,
      `SOURCE-GUARD-${Date.now()}`,
      "300.00",
      "360.00",
    );
    const response = await post(
      `/api/projects/${projectId}/certificats`,
      {
        ...manualCertificateBody(contractorId),
        contextDevisId: devisAId,
      },
    );

    expect(response.status).toBe(409);
    expect(response.body.code).toBe("ELIGIBLE_INVOICE_SOURCES_REQUIRED");
    expect(response.body.invoiceIds).toEqual([invoice.id]);
    await db.delete(invoices).where(eq(invoices.id, invoice.id));
  });

  it("allows manual fallback when the only approved unpaid invoice is the deposit invoice", async () => {
    const deposit = await insertInvoice(
      devisAId,
      `DEPOSIT-ONLY-${Date.now()}`,
      "300.00",
      "360.00",
    );
    await db
      .update(devis)
      .set({ acompteInvoiceId: deposit.id })
      .where(eq(devis.id, devisAId));

    try {
      const response = await post(
        `/api/projects/${projectId}/certificats`,
        {
          ...manualCertificateBody(contractorId),
          contextDevisId: devisAId,
        },
      );

      expect(response.status).toBe(201);
      const sourceRows = await db
        .select()
        .from(certificatSources)
        .where(eq(certificatSources.certificatId, response.body.id));
      expect(sourceRows).toHaveLength(0);
      await db.delete(certificats).where(eq(certificats.id, response.body.id));
    } finally {
      await db
        .update(devis)
        .set({ acompteInvoiceId: null })
        .where(eq(devis.id, devisAId));
      await db.delete(invoices).where(eq(invoices.id, deposit.id));
    }
  });

  it("requires and certifies only the progress invoice when a deposit invoice also exists", async () => {
    const deposit = await insertInvoice(
      devisAId,
      `DEPOSIT-MIXED-${Date.now()}`,
      "300.00",
      "360.00",
    );
    const progress = await insertInvoice(
      devisAId,
      `PROGRESS-MIXED-${Date.now()}`,
      "500.00",
      "600.00",
    );
    await db
      .update(devis)
      .set({ acompteInvoiceId: deposit.id })
      .where(eq(devis.id, devisAId));

    try {
      const manualResponse = await post(
        `/api/projects/${projectId}/certificats`,
        {
          ...manualCertificateBody(contractorId),
          contextDevisId: devisAId,
        },
      );
      expect(manualResponse.status).toBe(409);
      expect(manualResponse.body.code).toBe("ELIGIBLE_INVOICE_SOURCES_REQUIRED");
      expect(manualResponse.body.invoiceIds).toEqual([progress.id]);

      const createResponse = await post(
        `/api/invoices/${progress.id}/create-certificat`,
      );
      expect(createResponse.status).toBe(201);
      const sourceRows = await db
        .select()
        .from(certificatSources)
        .where(eq(certificatSources.certificatId, createResponse.body.id));
      expect(sourceRows.map((source) => source.invoiceId)).toEqual([progress.id]);
      await db
        .delete(certificatSources)
        .where(eq(certificatSources.certificatId, createResponse.body.id));
      await db.delete(certificats).where(eq(certificats.id, createResponse.body.id));
    } finally {
      await db
        .update(devis)
        .set({ acompteInvoiceId: null })
        .where(eq(devis.id, devisAId));
      await db
        .delete(invoices)
        .where(inArray(invoices.id, [deposit.id, progress.id]));
    }
  });

  it("404s on an unknown invoice", async () => {
    const r = await get(`/api/invoices/999999999/certificat-preview`);
    expect(r.status).toBe(404);
  });

  it("refuses to preview a contractor invoice before it is approved", async () => {
    const invoice = await insertInvoice(
      devisAId,
      `PENDING-${Date.now()}`,
      "300.00",
      "360.00",
    );
    await db
      .update(invoices)
      .set({ status: "pending" })
      .where(eq(invoices.id, invoice.id));

    const response = await get(`/api/invoices/${invoice.id}/certificat-preview`);
    expect(response.status).toBe(409);
    expect(response.body.code).toBe("INVOICE_NOT_APPROVED");
    await db.delete(invoices).where(eq(invoices.id, invoice.id));
  });

  it("previews the TRÜTKEN no-marché balance without persisting a certificat or source link", async () => {
    const suffix = Date.now();
    const [project] = await db.insert(projects).values({
      code: `T696-${suffix}`,
      name: "No-marché invoice balance regression",
      clientName: "Test Client",
      status: "active",
    }).returning();
    const [contractor] = await db.insert(contractors).values({
      name: `T696 Contractor ${suffix}`,
    }).returning();
    const [devisRow] = await db.insert(devis).values({
      projectId: project.id,
      contractorId: contractor.id,
      devisCode: `T696.${suffix}`,
      descriptionFr: "TRÜTKEN-style invoice balance",
      amountHt: "2075.00",
      amountTtc: "2490.00",
      acompteRequired: true,
      acompteAmountHt: "1240.00",
      acompteState: "applied",
      signOffStage: "client_signed_off",
      accountingState: "active",
      status: "confirmed",
    }).returning();
    const [acompteCertificat] = await db.insert(certificats).values({
      projectId: project.id,
      contractorId: contractor.id,
      certificateRef: `T696-AC-${suffix}`,
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
      acompteDevisId: devisRow.id,
      status: "paid",
    }).returning();
    const [source] = await db.insert(projectIntakeDocuments).values({
      projectId: project.id,
      fileName: "FR25.26-0144.pdf",
      storageKey: `tests/certificat-preview/${suffix}.pdf`,
      contentFingerprint: suffix.toString().padStart(64, "0"),
      extractedData: {
        documentType: "invoice",
        amountHt: 2075,
        amountTtc: 2490,
        netAPayer: 1002,
        acomptePaidAmountTtc: 1488,
      },
    }).returning();
    const [invoice] = await db.insert(invoices).values({
      projectId: project.id,
      contractorId: contractor.id,
      devisId: devisRow.id,
      sourceIntakeDocumentId: source.id,
      invoiceNumber: `T696-${suffix}`,
      amountHt: "2075.00",
      tvaAmount: "415.00",
      amountTtc: "2490.00",
      status: "approved",
    }).returning();
    await db.insert(invoiceAcompteApplications).values({
      invoiceId: invoice.id,
      devisId: devisRow.id,
      certificatId: acompteCertificat.id,
      sourceIntakeDocumentId: source.id,
      sourceStorageKey: source.storageKey,
      sourceFileName: source.fileName,
      sourceContentFingerprint: source.contentFingerprint,
      appliedHt: "1240.00",
      appliedTtc: "1488.00",
      invoiceGrossHt: "2075.00",
      invoiceGrossTtc: "2490.00",
      invoiceNetPayableTtc: "1002.00",
      evidenceText: "Acompte versé 1 488,00 €",
    });

    try {
      const certsBefore = await db.select({ id: certificats.id })
        .from(certificats)
        .where(eq(certificats.projectId, project.id));
      const linksBefore = await db.select({ id: certificatSources.id })
        .from(certificatSources)
        .where(eq(certificatSources.invoiceId, invoice.id));

      const preview = await get(`/api/invoices/${invoice.id}/certificat-preview`);

      expect(preview.status).toBe(200);
      expect(preview.body.derivation.totalWorksHt).toBe("2075.00");
      expect(preview.body.derivation.previousPayments).toBe("1240.00");
      expect(preview.body.deductions.retenueGarantie).toBe("0.00");
      expect(preview.body.deductions.netToPayHt).toBe("835.00");
      expect(preview.body.deductions.tvaAmount).toBe("167.00");
      expect(preview.body.deductions.netToPayTtc).toBe("1002.00");

      const certsAfter = await db.select({ id: certificats.id })
        .from(certificats)
        .where(eq(certificats.projectId, project.id));
      const linksAfter = await db.select({ id: certificatSources.id })
        .from(certificatSources)
        .where(eq(certificatSources.invoiceId, invoice.id));
      expect(certsAfter).toEqual(certsBefore);
      expect(linksBefore).toHaveLength(0);
      expect(linksAfter).toHaveLength(0);
    } finally {
      await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.allow_acompte_application_delete', 'true', true)`);
        await tx.delete(invoiceAcompteApplications).where(eq(invoiceAcompteApplications.invoiceId, invoice.id));
      });
      await db.delete(invoices).where(eq(invoices.id, invoice.id));
      await db.delete(projectIntakeDocuments).where(eq(projectIntakeDocuments.id, source.id));
      await db.delete(certificats).where(eq(certificats.id, acompteCertificat.id));
      await db.delete(devis).where(eq(devis.id, devisRow.id));
      await db.delete(contractors).where(eq(contractors.id, contractor.id));
      await db.delete(projects).where(eq(projects.id, project.id));
    }
  });

  it("Mode A: derives cumulative from invoice HT, creates a linked draft, then refuses double-certification", async () => {
    const inv = await insertInvoice(devisAId, "A-1", "4000.00", "4800.00");

    const forged = await post(
      `/api/invoices/${inv.id}/create-certificat`,
      { certificateRef: "C999999" },
    );
    expect(forged.status).toBe(400);
    expect(forged.body.code).toBe("CERTIFICATE_REFERENCE_SERVER_MANAGED");

    const preview = await get(`/api/invoices/${inv.id}/certificat-preview`);
    expect(preview.status).toBe(200);
    expect(preview.body.derivation.mode).toBe("invoice");
    expect(preview.body.derivation.totalWorksHt).toBe("4000.00");
    expect(preview.body.derivation.previousPayments).toBe("0.00");
    // 5% retenue on 4000
    expect(preview.body.deductions.retenueGarantie).toBe("200.00");
    expect(preview.body.deductions.netToPayHt).toBe("3800.00");

    const created = await post(`/api/invoices/${inv.id}/create-certificat`);
    expect(created.status).toBe(201);
    expect(created.body.totalWorksHt).toBe("4000.00");
    expect(created.body.netToPayHt).toBe("3800.00");
    expect(created.body.status).toBe("draft");

    // Source link written at creation.
    const links = await get(`/api/projects/${projectId}/certificat-invoice-links`);
    expect(links.status).toBe(200);
    expect(links.body.some((l: { invoiceId: number; certificatId: number }) => l.invoiceId === inv.id && l.certificatId === created.body.id)).toBe(true);

    // Second attempt refused, preview included.
    const again = await post(`/api/invoices/${inv.id}/create-certificat`);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("INVOICE_ALREADY_CERTIFIED");
    const previewAgain = await get(`/api/invoices/${inv.id}/certificat-preview`);
    expect(previewAgain.status).toBe(409);
    expect(previewAgain.body.certificateRef).toBe(created.body.certificateRef);
  });

  it("chains previous payments from the prior certificat (previousPayments + netToPayHt)", async () => {
    const inv = await insertInvoice(devisAId, "A-2", "2000.00", "2400.00");
    const preview = await get(`/api/invoices/${inv.id}/certificat-preview`);
    expect(preview.status).toBe(200);
    // Prior cert: totalWorks 4000, net 3800. New cumulative = 6000, previous = 3800.
    expect(preview.body.derivation.totalWorksHt).toBe("6000.00");
    expect(preview.body.derivation.previousPayments).toBe("3800.00");
    // retenue cumul 300 → period 100; net = 6000 − 300 − 3800 + prior retenue... net HT = 6000 − 300 − 3800 = 1900
    expect(preview.body.deductions.netToPayHt).toBe("1900.00");
    const created = await post(`/api/invoices/${inv.id}/create-certificat`);
    expect(created.status).toBe(201);
    expect(created.body.previousPayments).toBe("3800.00");
  });

  it("Mode B: uses the linked situation's cumulative − previous as the period claim", async () => {
    const inv = await insertInvoice(devisBId, "B-1", "2850.00", "3420.00");
    await db.insert(situations).values({
      devisId: devisBId,
      invoiceId: inv.id,
      situationNumber: 1,
      cumulativeHt: "3000.00",
      previousHt: "0.00",
      netHt: "3000.00",
      retenueGarantie: "150.00",
      netToPayHt: "2850.00",
      tvaAmount: "570.00",
      netToPayTtc: "3420.00",
      status: "confirmed",
    });
    const preview = await get(`/api/invoices/${inv.id}/certificat-preview`);
    expect(preview.status).toBe(200);
    expect(preview.body.derivation.mode).toBe("situation");
    expect(preview.body.derivation.periodClaimHt).toBe(3000);
    // Prior chain now: cumulative 6000, prior net 3800 + 1900 = 5700.
    expect(preview.body.derivation.totalWorksHt).toBe("9000.00");
    expect(preview.body.derivation.previousPayments).toBe("5700.00");
    const created = await post(`/api/invoices/${inv.id}/create-certificat`);
    expect(created.status).toBe(201);
    expect(created.body.totalWorksHt).toBe("9000.00");
  });

  it("excludes superseded and acompte certificats from the prior chain", async () => {
    // Superseded decoy with huge figures + an acompte cert with zero cumulatives.
    await db.insert(certificats).values([
      {
        projectId, contractorId, certificateRef: "T496-SUP", status: "superseded",
        totalWorksHt: "99999.00", previousPayments: "99999.00", netToPayHt: "99999.00",
        pvMvAdjustment: "0.00", retenueGarantie: "0.00", cumulativeProrataDeduction: "0.00", periodProrataDeduction: "0.00",
        tvaAmount: "0.00", netToPayTtc: "0.00", dateIssued: "2099-01-01",
      },
      {
        projectId, contractorId, certificateRef: "T496-AC", status: "sent", acompteDevisId: devisAId,
        totalWorksHt: "3000.00", previousPayments: "0.00", netToPayHt: "3000.00",
        pvMvAdjustment: "0.00", retenueGarantie: "0.00", cumulativeProrataDeduction: "0.00", periodProrataDeduction: "0.00",
        tvaAmount: "600.00", netToPayTtc: "3600.00", dateIssued: "2099-01-01",
      },
    ]);
    const inv = await insertInvoice(devisAId, "A-3", "1000.00", "1200.00");
    const preview = await get(`/api/invoices/${inv.id}/certificat-preview`);
    expect(preview.status).toBe(200);
    // Chain still built from the real progress certs: 9000 + 1000.
    expect(preview.body.derivation.totalWorksHt).toBe("10000.00");
    expect(preview.body.derivation.priorCertificateRef).not.toBe("T496-SUP");
    await db.delete(certificats).where(inArray(certificats.certificateRef, ["T496-SUP", "T496-AC"]));
    await db.delete(invoices).where(eq(invoices.id, inv.id));
  });

  it("refuses the facture d'acompte and invoices on void devis", async () => {
    const acompteInv = await insertInvoice(devisAId, "A-ACOMPTE", "3000.00", "3600.00");
    await db.update(devis).set({ acompteInvoiceId: acompteInv.id }).where(eq(devis.id, devisAId));
    const r1 = await post(`/api/invoices/${acompteInv.id}/create-certificat`);
    expect(r1.status).toBe(409);
    expect(r1.body.code).toBe("INVOICE_IS_ACOMPTE");
    await db.update(devis).set({ acompteInvoiceId: null }).where(eq(devis.id, devisAId));
    await db.delete(invoices).where(eq(invoices.id, acompteInv.id));

    const [voidDevis] = await db
      .insert(devis)
      .values({
        projectId, contractorId, devisCode: "T496.VOID", descriptionFr: "void",
        amountHt: "1000.00", amountTtc: "1200.00", status: "void", signOffStage: "void",
      })
      .returning();
    const voidInv = await insertInvoice(voidDevis.id, "V-1", "1000.00", "1200.00");
    const r2 = await post(`/api/invoices/${voidInv.id}/create-certificat`);
    expect(r2.status).toBe(409);
    expect(r2.body.code).toBe("DEVIS_VOID");
    await db.delete(invoices).where(eq(invoices.id, voidInv.id));
    await db.delete(devis).where(eq(devis.id, voidDevis.id));
  });

  it("concurrent creations from TWO different invoices chain correctly (no stale prior)", async () => {
    const invX = await insertInvoice(devisAId, "A-RACE-1", "300.00", "360.00");
    const invY = await insertInvoice(devisBId, "B-RACE-2", "700.00", "840.00");
    const [r1, r2] = await Promise.all([
      post(`/api/invoices/${invX.id}/create-certificat`),
      post(`/api/invoices/${invY.id}/create-certificat`),
    ]);
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    // Chain before this test: cumulative 9000. The two certs must be
    // sequential — whichever committed second must include the first in its
    // prior chain, never both deriving from the same stale prior.
    const totals = [parseFloat(r1.body.totalWorksHt), parseFloat(r2.body.totalWorksHt)].sort((a, b) => a - b);
    const expected = [
      [9000 + 300, 9000 + 300 + 700],
      [9000 + 700, 9000 + 700 + 300],
    ];
    expect(expected.some(([lo, hi]) => totals[0] === lo && totals[1] === hi)).toBe(true);
    // previousPayments of the later cert must include the earlier cert's net.
    const later = parseFloat(r1.body.totalWorksHt) > parseFloat(r2.body.totalWorksHt) ? r1.body : r2.body;
    const earlier = later === r1.body ? r2.body : r1.body;
    expect(parseFloat(later.previousPayments)).toBeCloseTo(
      parseFloat(earlier.previousPayments) + parseFloat(earlier.netToPayHt),
      2,
    );
  });

  it("a concurrent double-click creates exactly one certificat", async () => {
    const inv = await insertInvoice(devisBId, "B-RACE", "500.00", "600.00");
    const [r1, r2] = await Promise.all([
      post(`/api/invoices/${inv.id}/create-certificat`),
      post(`/api/invoices/${inv.id}/create-certificat`),
    ]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([201, 409]);
    const links = await db.select().from(certificatSources).where(eq(certificatSources.invoiceId, inv.id));
    expect(links.length).toBe(1);
  });
});
