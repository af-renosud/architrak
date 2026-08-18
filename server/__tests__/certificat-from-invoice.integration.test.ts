import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import http from "http";
import express from "express";
import type { AddressInfo } from "net";
import { db } from "../db";
import { certificats, certificatSources, projects, contractors, marches, devis, invoices, situations } from "@shared/schema";
import { eq, inArray } from "drizzle-orm";
import certificatsRouter from "../routes/certificats";

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

async function insertInvoice(devisId: number, num: string, ht: string, ttc: string) {
  const [inv] = await db
    .insert(invoices)
    .values({ devisId, contractorId, projectId, invoiceNumber: num, amountHt: ht, tvaAmount: "0.00", amountTtc: ttc, status: "pending" })
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
  it("404s on an unknown invoice", async () => {
    const r = await get(`/api/invoices/999999999/certificat-preview`);
    expect(r.status).toBe(404);
  });

  it("Mode A: derives cumulative from invoice HT, creates a linked draft, then refuses double-certification", async () => {
    const inv = await insertInvoice(devisAId, "A-1", "4000.00", "4800.00");

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
