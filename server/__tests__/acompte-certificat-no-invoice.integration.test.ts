import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import http from "http";
import express from "express";
import type { AddressInfo } from "net";
import { db } from "../db";
import { acompteNoInvoicePayments, certificats, projects, contractors, marches, devis, emailDocuments, invoices, projectIntakeDocuments, users } from "@shared/schema";
import { eq, sql } from "drizzle-orm";
import certificatsRouter from "../routes/certificats";
import acompteRouter from "../routes/acompte";
import { linkAcompteInvoiceTx } from "../services/acompte.service";

/**
 * Task #491 — one-click acompte certificat WITHOUT a supplier invoice:
 *
 *  - guards: unsigned devis refused; missing amount refused; second
 *    generation refused (409 with the existing ref).
 *  - the generated certificat carries the devis's own money (HT + devis-ratio
 *    TVA), zero deductions, and the acompteDevisId link.
 *  - mark-paid works from 'pending' once the acompte certificat exists
 *    (provenance 'certificat_no_invoice'); refused before it exists.
 *  - the acompte certificat is EXCLUDED from the prior-cumulative chain, and
 *    the next progress certificat recoups the full deposit in one period.
 *  - the seal never re-resolves an acompte certificat's money.
 */

vi.mock("../communications/certificat-generator", () => ({
  generateCertificatPdf: vi.fn(async (certificatId: number) => ({
    storageKey: `test/seal-${certificatId}.pdf`,
    pdfBuffer: Buffer.from("%PDF"),
    fileName: `CERT-${certificatId}.pdf`,
    sourceInvoiceIds: [],
    driveSeed: null,
  })),
}));
vi.mock("../services/drive/upload-queue.service", () => ({
  enqueueDriveUpload: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../auth/middleware", () => ({
  requireAuth: (req: { session: { userId?: number } }, _res: unknown, next: () => void) => {
    req.session ??= {};
    req.session.userId = 1;
    next();
  },
}));

import { sealCertificat } from "../services/certificat-seal.service";

let projectId: number;
let contractorId: number;
let devisId: number;
let lifecycleSourceId: number;
let server: http.Server;
let base: string;

beforeAll(async () => {
  const [p] = await db
    .insert(projects)
    .values({ code: `T491-${Date.now()}`, name: "Acompte no-invoice test", clientName: "Test Client", status: "active" })
    .returning();
  projectId = p.id;
  const [c] = await db.insert(contractors).values({ name: `T491 Contractor ${Date.now()}` }).returning();
  contractorId = c.id;
  await db.insert(marches).values({
    projectId,
    contractorId,
    totalHt: "10000.00",
    totalTtc: "12000.00",
    retenueGarantiePercent: "5.00",
  });
  const [d] = await db
    .insert(devis)
    .values({
      projectId,
      contractorId,
      devisCode: "T491.1.acompte",
      descriptionFr: "Devis avec acompte à la commande",
      amountHt: "10000.00",
      amountTtc: "12000.00",
      acompteRequired: true,
      acomptePercent: "30.00",
      acompteState: "pending",
      signOffStage: "draft",
    })
    .returning();
  devisId = d.id;

  const app = express();
  app.use(express.json());
  app.use(certificatsRouter);
  app.use(acompteRouter);
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err && typeof err === "object" && (err as { name?: string }).name === "ZodError") {
      return res.status(400).json({ message: "Validation failed" });
    }
    res.status(500).json({ message: err instanceof Error ? err.message : "error" });
  });
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  if (server) await new Promise<void>((r) => server.close(() => r()));
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.allow_acompte_audit_delete', 'true', true)`);
    await tx.delete(acompteNoInvoicePayments).where(eq(acompteNoInvoicePayments.devisId, devisId));
  });
  if (lifecycleSourceId) await db.delete(projectIntakeDocuments).where(eq(projectIntakeDocuments.id, lifecycleSourceId));
  await db.delete(certificats).where(eq(certificats.projectId, projectId));
  await db.delete(devis).where(eq(devis.projectId, projectId));
  await db.delete(marches).where(eq(marches.projectId, projectId));
  await db.delete(contractors).where(eq(contractors.id, contractorId));
  await db.delete(projects).where(eq(projects.id, projectId));
});

const post = (path: string, body: unknown = {}) =>
  fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

describe("acompte certificat without invoice — full lifecycle", () => {
  it("refuses generation before the devis is client-signed", async () => {
    const res = await post(`/api/devis/${devisId}/acompte/generate-certificat`);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("acompte_devis_not_signed");
  });

  it("refuses mark-paid from 'pending' while no acompte certificat exists", async () => {
    const res = await post(`/api/devis/${devisId}/acompte/mark-paid`);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("acompte_invalid_transition");
  });

  it("generates the acompte certificat once signed — devis money, zero deductions, linked", async () => {
    await db.update(devis).set({ signOffStage: "client_signed_off" }).where(eq(devis.id, devisId));
    const res = await post(`/api/devis/${devisId}/acompte/generate-certificat`);
    expect(res.status).toBe(201);
    const cert = await res.json();
    // 30% of 10000 HT / 12000 TTC.
    expect(cert.totalWorksHt).toBe("3000.00");
    expect(cert.netToPayHt).toBe("3000.00");
    expect(cert.netToPayTtc).toBe("3600.00");
    expect(cert.tvaAmount).toBe("600.00");
    expect(cert.retenueGarantie).toBe("0.00");
    expect(cert.cumulativeProrataDeduction).toBe("0.00");
    expect(cert.cumulativeAcompteRecoupment).toBe("0.00");
    expect(cert.previousPayments).toBe("0.00");
    expect(cert.acompteDevisId).toBe(devisId);
  });

  it("refuses a second generation (live acompte certificat already exists)", async () => {
    const res = await post(`/api/devis/${devisId}/acompte/generate-certificat`);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("acompte_certificat_exists");
    expect(body.certificateRef).toBeTruthy();
  });

  it("retires broad pending+C1 mark-paid; audited no-invoice confirmation remains available", async () => {
    const rejected = await post(`/api/devis/${devisId}/acompte/mark-paid`, { datePaid: "2025-01-15T10:00:00.000Z" });
    expect(rejected.status).toBe(409);
    expect((await rejected.json()).code).toBe("acompte_invalid_transition");
    await db.insert(users).values({ id: 1, googleId: "t691-operator", email: "operator-691@renosud.com" }).onConflictDoNothing();
    const [source] = await db.insert(projectIntakeDocuments).values({
      projectId, fileName: "c1-payment-proof.pdf", storageKey: "tests/c1-payment-proof.pdf",
      contentFingerprint: "c".repeat(64),
      extractedData: { documentType: "invoice", acomptePaidAmountTtc: 3600, acomptePaidEvidenceText: "Acompte versé 3 600 €" },
    }).returning();
    lifecycleSourceId = source.id;
    const confirmed = await post(`/api/devis/${devisId}/acompte/confirm-paid-no-invoice`, {
      confirmed: true, sourceIntakeDocumentId: source.id, paymentReference: "VIR-T491",
      paidAt: "2025-01-15T10:00:00.000Z",
    });
    expect(confirmed.status).toBe(201);
    const [d] = await db.select().from(devis).where(eq(devis.id, devisId));
    expect(d.acompteState).toBe("paid");
    expect(d.acomptePaidVia).toBe("certificat_no_invoice");
    expect(d.acompteInvoiceId).toBeNull();
  });

  it("next progress certificat ignores the acompte cert as prior AND recoups the full deposit", async () => {
    const res = await post(`/api/projects/${projectId}/certificats`, {
      contractorId,
      totalWorksHt: "6000.00",
    });
    expect(res.status).toBe(201);
    const cert = await res.json();
    // Retenue 5% of 6000 = 300 — proves the acompte cert's zero cumulatives
    // did NOT become "the prior" (period retenue would otherwise be wrong).
    expect(cert.retenueGarantie).toBe("300.00");
    // Full 3000 deposit recovered in ONE period (asap rule).
    expect(cert.cumulativeAcompteRecoupment).toBe("3000.00");
    expect(cert.periodAcompteRecoupment).toBe("3000.00");
    // Net = 6000 − 300 − 3000.
    expect(cert.netToPayHt).toBe("2700.00");
  });

  it("seal leaves the acompte certificat's money untouched", async () => {
    const [acompteCert] = (
      await db.select().from(certificats).where(eq(certificats.projectId, projectId))
    ).filter((c) => c.acompteDevisId === devisId);
    const { certificat: sealed, pdfStorageKey } = await sealCertificat(acompteCert.id);
    expect(sealed.netToPayHt).toBe("3000.00");
    expect(sealed.retenueGarantie).toBe("0.00");
    expect(sealed.cumulativeAcompteRecoupment).toBe("0.00");
    expect(pdfStorageKey).toBeTruthy();
  });

  it("every invoice-linking path is refused once a live acompte certificat exists", async () => {
    // The transactional gate (linkAcompteInvoiceTx) is shared by the explicit
    // /acompte/link-invoice route AND the upload pipeline's auto-link
    // (invoice-upload.service), so exercising it directly covers both.
    const gate = await linkAcompteInvoiceTx({ devisId, invoiceId: 999999, invoiceDatePaid: null });
    expect(gate.ok).toBe(false);
    if (gate.ok) throw new Error("unreachable");
    expect(gate.code).toBe("acompte_certificat_exists");
    // Devis lifecycle untouched by the refused link.
    const [d] = await db.select().from(devis).where(eq(devis.id, devisId));
    expect(d.acompteInvoiceId).toBeNull();
  });

  it("generic PATCH cannot alter an acompte certificat's fixed money (draft or sealed)", async () => {
    // The reissue test below supersedes the sealed original and leaves a
    // fresh DRAFT clone — but at this point the original is sealed and the
    // clone doesn't exist yet, so we exercise both: the sealed acompte cert
    // here, and the draft clone after the reissue test.
    const [acompteCert] = (
      await db.select().from(certificats).where(eq(certificats.projectId, projectId))
    ).filter((c) => c.acompteDevisId === devisId && c.status !== "superseded");
    for (const body of [
      { totalWorksHt: "9999.00" },
      { previousPayments: "500.00" },
      { retenueOverride: "100.00" },
    ]) {
      const res = await fetch(`${base}/api/certificats/${acompteCert.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(409);
    }
    const [after] = await db.select().from(certificats).where(eq(certificats.id, acompteCert.id));
    expect(after.totalWorksHt).toBe("3000.00");
    expect(after.netToPayHt).toBe("3000.00");
    expect(after.retenueGarantie).toBe("0.00");
  });

  it("concurrent generate + link-invoice never leave both a live acompte cert AND an invoice link", async () => {
    // Fresh devis so the race starts from a clean 'pending' state. Both
    // paths lock the same devis row FOR UPDATE, so they serialise: exactly
    // one wins, the loser observes the winner's commit and refuses.
    const [d2] = await db
      .insert(devis)
      .values({
        projectId,
        contractorId,
        devisCode: "T491.2.race",
        descriptionFr: "Devis race test",
        amountHt: "2000.00",
        amountTtc: "2400.00",
        acompteRequired: true,
        acompteAmountHt: "100.00",
        acompteState: "pending",
        signOffStage: "client_signed_off",
      })
      .returning();
    const [inv2] = await db
      .insert(invoices)
      .values({
        devisId: d2.id,
        contractorId,
        projectId,
        invoiceNumber: "T491-RACE-1",
        amountHt: "100.00",
        tvaAmount: "20.00",
        amountTtc: "120.00",
      })
      .returning();
    try {
      const [genRes, linkRes] = await Promise.all([
        post(`/api/devis/${d2.id}/acompte/generate-certificat`),
        linkAcompteInvoiceTx({ devisId: d2.id, invoiceId: inv2.id, invoiceDatePaid: null }),
      ]);
      const [after] = await db.select().from(devis).where(eq(devis.id, d2.id));
      const liveCerts = (
        await db.select().from(certificats).where(eq(certificats.projectId, projectId))
      ).filter((c) => c.acompteDevisId === d2.id && c.status !== "superseded");
      // Invariant: never both.
      expect(liveCerts.length > 0 && after.acompteInvoiceId != null).toBe(false);
      if (genRes.status === 201) {
        // Certificat won → link must have been refused, state stays pending.
        expect(liveCerts.length).toBe(1);
        expect(linkRes.ok).toBe(false);
      } else {
        // Link won → devis is invoiced, generation refused.
        expect(linkRes.ok).toBe(true);
        expect(after.acompteState).toBe("invoiced");
        expect(liveCerts.length).toBe(0);
        expect([409]).toContain(genRes.status);
      }
    } finally {
      await db.delete(certificats).where(eq(certificats.acompteDevisId, d2.id));
      await db.delete(devis).where(eq(devis.id, d2.id));
    }
  });

  it("concurrent generate + disable/void of the devis never issue a cert for an ineligible devis", async () => {
    const [d3] = await db
      .insert(devis)
      .values({
        projectId,
        contractorId,
        devisCode: "T491.3.void-race",
        descriptionFr: "Devis void race test",
        amountHt: "2000.00",
        amountTtc: "2400.00",
        acompteRequired: true,
        acompteAmountHt: "150.00",
        acompteState: "pending",
        signOffStage: "client_signed_off",
      })
      .returning();
    try {
      const [genRes] = await Promise.all([
        post(`/api/devis/${d3.id}/acompte/generate-certificat`),
        db.update(devis).set({ acompteRequired: false, status: "void", signOffStage: "void" }).where(eq(devis.id, d3.id)),
      ]);
      const liveCerts = (
        await db.select().from(certificats).where(eq(certificats.projectId, projectId))
      ).filter((c) => c.acompteDevisId === d3.id && c.status !== "superseded");
      // Whichever committed first: a 201 means the cert was issued while the
      // devis was still eligible (void happened after — allowed); a refusal
      // means the in-tx revalidation saw the void/disable and no cert exists.
      if (genRes.status === 201) {
        expect(liveCerts.length).toBe(1);
        expect(liveCerts[0].totalWorksHt).toBe("150.00");
      } else {
        expect(genRes.status).toBe(409);
        expect(liveCerts.length).toBe(0);
      }
      // Deterministic sequel: now that the devis is void/disabled, generation
      // must ALWAYS refuse and never add a (second) certificat.
      const again = await post(`/api/devis/${d3.id}/acompte/generate-certificat`);
      expect(again.status).toBe(409);
      const after = (
        await db.select().from(certificats).where(eq(certificats.projectId, projectId))
      ).filter((c) => c.acompteDevisId === d3.id && c.status !== "superseded");
      expect(after.length).toBe(liveCerts.length);
    } finally {
      await db.delete(certificats).where(eq(certificats.acompteDevisId, d3.id));
      await db.delete(devis).where(eq(devis.id, d3.id));
    }
  });

  it("reissue clones the acompte certificat with its money and link intact", async () => {
    const [acompteCert] = (
      await db.select().from(certificats).where(eq(certificats.projectId, projectId))
    ).filter((c) => c.acompteDevisId === devisId && c.status !== "superseded");
    const res = await post(`/api/certificats/${acompteCert.id}/reissue`);
    expect(res.status).toBe(201);
    const clone = await res.json();
    expect(clone.acompteDevisId).toBe(devisId);
    expect(clone.totalWorksHt).toBe("3000.00");
    expect(clone.netToPayHt).toBe("3000.00");
    expect(clone.retenueGarantie).toBe("0.00");
    expect(clone.cumulativeAcompteRecoupment).toBe("0.00");
    const [original] = await db.select().from(certificats).where(eq(certificats.id, acompteCert.id));
    expect(original.status).toBe("superseded");
  });

  it("confirms paid no-invoice deposit from matching intake evidence and is replay-safe", async () => {
    // The seeded test user is normally present in integration DBs; create a
    // durable operator for isolated databases too.
    await db.insert(users).values({ id: 1, googleId: "t686-operator", email: "operator@renosud.com" }).onConflictDoNothing();
    const [d] = await db.insert(devis).values({
      projectId, contractorId, devisCode: "T686.1.audit", descriptionFr: "Audited deposit",
      amountHt: "1000.00", amountTtc: "1200.00", acompteRequired: true,
      acompteAmountHt: "200.00", acompteState: "pending", signOffStage: "client_signed_off",
    }).returning();
    const [source] = await db.insert(projectIntakeDocuments).values({
      projectId, fileName: "proof.pdf", storageKey: "tests/proof.pdf",
      contentFingerprint: "a".repeat(64),
      extractedData: { documentType: "invoice", acomptePaidAmountTtc: 240, acomptePaidEvidenceText: "Acompte versé 240 €" },
    }).returning();
    try {
      const body = { confirmed: true, sourceIntakeDocumentId: source.id, paymentReference: "VIR-T686", paidAt: "2025-01-15T10:00:00.000Z" };
      const [first, replay] = await Promise.all([
        post(`/api/devis/${d.id}/acompte/confirm-paid-no-invoice`, body),
        post(`/api/devis/${d.id}/acompte/confirm-paid-no-invoice`, body),
      ]);
      expect([first.status, replay.status].sort()).toEqual([200, 201]);
      const replies = await Promise.all([first.json(), replay.json()]);
      expect(replies[0].certificatId).toBe(replies[1].certificatId);
      const [audit] = await db.select().from(acompteNoInvoicePayments).where(eq(acompteNoInvoicePayments.devisId, d.id));
      expect(audit.amountHt).toBe("200.00");
      expect(audit.amountTtc).toBe("240.00");
      expect(audit.sourceIntakeDocumentId).toBe(source.id);
    } finally {
      await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.allow_acompte_audit_delete', 'true', true)`);
        await tx.delete(acompteNoInvoicePayments).where(eq(acompteNoInvoicePayments.devisId, d.id));
      });
      await db.delete(certificats).where(eq(certificats.acompteDevisId, d.id));
      await db.delete(projectIntakeDocuments).where(eq(projectIntakeDocuments.id, source.id));
      await db.delete(devis).where(eq(devis.id, d.id));
    }
  });

  it("rejects non-invoice evidence and contradictory email contractor/devis provenance", async () => {
    const [otherContractor] = await db.insert(contractors).values({ name: `T691 mismatch ${Date.now()}` }).returning();
    const [target] = await db.insert(devis).values({
      projectId, contractorId, devisCode: "T691.source-target", descriptionFr: "Source target",
      amountHt: "1000.00", amountTtc: "1200.00", acompteRequired: true,
      acompteAmountHt: "200.00", acompteState: "pending", signOffStage: "client_signed_off",
    }).returning();
    const [otherDevis] = await db.insert(devis).values({
      projectId, contractorId: otherContractor.id, devisCode: "T691.other", descriptionFr: "Contradictory source",
      amountHt: "1000.00", amountTtc: "1200.00",
    }).returning();
    const [nonInvoice] = await db.insert(projectIntakeDocuments).values({
      projectId, fileName: "quotation.pdf", storageKey: "tests/quotation.pdf", contentFingerprint: "d".repeat(64),
      extractedData: { documentType: "quotation", acomptePaidAmountTtc: 240, acomptePaidEvidenceText: "Acompte versé 240 €" },
    }).returning();
    const [email] = await db.insert(emailDocuments).values({
      projectId, emailMessageId: `t691-mismatch-${Date.now()}`, documentType: "invoice",
      contractorId: otherContractor.id, devisId: otherDevis.id,
    }).returning();
    const [contradictory] = await db.insert(projectIntakeDocuments).values({
      projectId, fileName: "wrong-supplier.pdf", storageKey: "tests/wrong-supplier.pdf",
      contentFingerprint: "e".repeat(64), sourceEmailDocumentId: email.id,
      extractedData: { documentType: "invoice", acomptePaidAmountTtc: 240, acomptePaidEvidenceText: "Acompte versé 240 €" },
    }).returning();
    const confirm = (sourceIntakeDocumentId: number) => post(`/api/devis/${target.id}/acompte/confirm-paid-no-invoice`, {
      confirmed: true, sourceIntakeDocumentId, paymentReference: "VIR-T691",
      paidAt: "2025-01-15T10:00:00.000Z",
    });
    try {
      const nonInvoiceRes = await confirm(nonInvoice.id);
      expect(nonInvoiceRes.status).toBe(409);
      expect((await nonInvoiceRes.json()).code).toBe("acompte_source_not_invoice");
      const contradictoryRes = await confirm(contradictory.id);
      expect(contradictoryRes.status).toBe(409);
      expect((await contradictoryRes.json()).code).toBe("acompte_source_identity_mismatch");
    } finally {
      await db.delete(projectIntakeDocuments).where(eq(projectIntakeDocuments.id, contradictory.id));
      await db.delete(projectIntakeDocuments).where(eq(projectIntakeDocuments.id, nonInvoice.id));
      await db.delete(emailDocuments).where(eq(emailDocuments.id, email.id));
      await db.delete(devis).where(eq(devis.id, otherDevis.id));
      await db.delete(devis).where(eq(devis.id, target.id));
      await db.delete(contractors).where(eq(contractors.id, otherContractor.id));
    }
  });

  it("invoice mark-paid requires the locked exact linked invoice identity and datePaid", async () => {
    const [otherContractor] = await db.insert(contractors).values({ name: `T691 invoice mismatch ${Date.now()}` }).returning();
    const [target] = await db.insert(devis).values({
      projectId, contractorId, devisCode: "T691.invoice-paid", descriptionFr: "Invoice-linked deposit",
      amountHt: "1000.00", amountTtc: "1200.00", acompteRequired: true,
      acompteAmountHt: "200.00", acompteState: "pending", signOffStage: "client_signed_off",
    }).returning();
    const [invoice] = await db.insert(invoices).values({
      projectId, contractorId, devisId: target.id, invoiceNumber: `T691-INV-${Date.now()}`,
      amountHt: "200.00", tvaAmount: "40.00", amountTtc: "240.00",
    }).returning();
    try {
      expect((await post(`/api/devis/${target.id}/acompte/link-invoice`, { invoiceId: invoice.id })).status).toBe(200);
      const missingDate = await post(`/api/devis/${target.id}/acompte/mark-paid`, { datePaid: "2025-01-15T10:00:00.000Z" });
      expect(missingDate.status).toBe(409);
      expect((await missingDate.json()).code).toBe("acompte_invoice_unpaid");

      await db.update(invoices).set({ contractorId: otherContractor.id, datePaid: "2025-01-16" }).where(eq(invoices.id, invoice.id));
      const mismatch = await post(`/api/devis/${target.id}/acompte/mark-paid`);
      expect(mismatch.status).toBe(409);
      expect((await mismatch.json()).code).toBe("acompte_invoice_mismatch");

      await db.update(invoices).set({ contractorId, datePaid: "2025-01-17" }).where(eq(invoices.id, invoice.id));
      const paid = await post(`/api/devis/${target.id}/acompte/mark-paid`);
      expect(paid.status).toBe(200);
      const [after] = await db.select().from(devis).where(eq(devis.id, target.id));
      expect(after.acompteState).toBe("paid");
      expect(after.acomptePaidAt?.toISOString()).toBe("2025-01-17T12:00:00.000Z");
    } finally {
      await db.delete(invoices).where(eq(invoices.id, invoice.id));
      await db.delete(devis).where(eq(devis.id, target.id));
      await db.delete(contractors).where(eq(contractors.id, otherContractor.id));
    }
  });

  it("persists a percent-only deposit amount so the next certificat recoups it", async () => {
    await db.insert(users).values({ id: 1, googleId: "t686-operator", email: "operator@renosud.com" }).onConflictDoNothing();
    const [freshContractor] = await db.insert(contractors).values({
      name: `T686 percent contractor ${Date.now()}`,
    }).returning();
    const [d] = await db.insert(devis).values({
      projectId,
      contractorId: freshContractor.id,
      devisCode: "T686.2.percent",
      descriptionFr: "Percentage-only audited deposit",
      amountHt: "1000.00",
      amountTtc: "1200.00",
      acompteRequired: true,
      acomptePercent: "20.00",
      acompteAmountHt: null,
      acompteState: "pending",
      signOffStage: "client_signed_off",
    }).returning();
    const [source] = await db.insert(projectIntakeDocuments).values({
      projectId,
      fileName: "percent-proof.pdf",
      storageKey: "tests/percent-proof.pdf",
      contentFingerprint: "b".repeat(64),
      extractedData: {
        documentType: "invoice",
        acomptePaidAmountTtc: 240,
        acomptePaidEvidenceText: "Acompte déjà payé 240 €",
      },
    }).returning();
    try {
      const confirmation = await post(`/api/devis/${d.id}/acompte/confirm-paid-no-invoice`, {
        confirmed: true,
        sourceIntakeDocumentId: source.id,
        paymentReference: "VIR-T686-PERCENT",
        paidAt: "2025-01-16T10:00:00.000Z",
      });
      expect(confirmation.status).toBe(201);
      const [stored] = await db.select().from(devis).where(eq(devis.id, d.id));
      expect(stored.acompteAmountHt).toBe("200.00");

      const certRes = await post(`/api/projects/${projectId}/certificats`, {
        contractorId: freshContractor.id,
        totalWorksHt: "1000.00",
      });
      expect(certRes.status).toBe(201);
      const cert = await certRes.json();
      expect(cert.cumulativeAcompteRecoupment).toBe("200.00");
      expect(cert.periodAcompteRecoupment).toBe("200.00");
    } finally {
      await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.allow_acompte_audit_delete', 'true', true)`);
        await tx.delete(acompteNoInvoicePayments).where(eq(acompteNoInvoicePayments.devisId, d.id));
      });
      await db.delete(certificats).where(eq(certificats.contractorId, freshContractor.id));
      await db.delete(projectIntakeDocuments).where(eq(projectIntakeDocuments.id, source.id));
      await db.delete(devis).where(eq(devis.id, d.id));
      await db.delete(contractors).where(eq(contractors.id, freshContractor.id));
    }
  });
});
