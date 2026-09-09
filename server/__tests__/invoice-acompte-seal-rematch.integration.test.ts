import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { eq, sql } from "drizzle-orm";
import { db } from "../db";
import {
  certificatSources,
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
  invoiceAcompteProtectedSnapshot,
} from "../services/invoice-acompte-application.service";
import rematchRouter from "../routes/admin-invoice-rematch";
import invoicesRouter from "../routes/invoices";

let invoiceId: number;
let raceInvoiceId: number;
let certificateSourceInvoiceId: number;
let supersededSourceInvoiceId: number;
let certificateId: number;
let projectId: number;
let contractorId: number;
let base: string;
let server: http.Server;

beforeAll(async () => {
  const nonce = Date.now();
  await db.insert(users).values({ id: 1, googleId: `seal-rematch-${nonce}`, email: `seal-rematch-${nonce}@test.invalid` })
    .onConflictDoNothing();
  const [project] = await db.insert(projects).values({
    code: `SEAL-${nonce}`, name: "Acompte seal test", clientName: "Test client", status: "active",
  }).returning();
  projectId = project.id;
  const [contractor] = await db.insert(contractors).values({ name: `Seal contractor ${nonce}` }).returning();
  contractorId = contractor.id;
  const [devisRow] = await db.insert(devis).values({
    projectId: project.id, contractorId: contractor.id, devisCode: `SEAL-${nonce}`,
    descriptionFr: "seal test", amountHt: "100.00", amountTtc: "120.00",
  }).returning();
  const [certificat] = await db.insert(certificats).values({
    projectId: project.id, contractorId: contractor.id, certificateRef: `SEAL-C-${nonce}`,
    dateIssued: "2026-01-01", totalWorksHt: "100.00", pvMvAdjustment: "0.00",
    previousPayments: "0.00", retenueGarantie: "0.00", cumulativeProrataDeduction: "0.00",
    periodProrataDeduction: "0.00", cumulativeAcompteRecoupment: "0.00",
    periodAcompteRecoupment: "0.00", netToPayHt: "100.00", tvaAmount: "20.00",
    netToPayTtc: "120.00",
  }).returning();
  certificateId = certificat.id;
  const [source] = await db.insert(projectIntakeDocuments).values({
    projectId: project.id, fileName: "seal.pdf", storageKey: `tests/seal-${nonce}.pdf`,
    contentFingerprint: "a".repeat(64), extractedData: { documentType: "invoice" },
  }).returning();
  const [invoice] = await db.insert(invoices).values({
    projectId: project.id, contractorId: contractor.id, devisId: devisRow.id,
    sourceIntakeDocumentId: source.id, invoiceNumber: `SEAL-I-${nonce}`,
    amountHt: "100.00", tvaAmount: "20.00", amountTtc: "120.00",
    pdfPath: `tests/seal-${nonce}.pdf`, aiExtractedData: { documentType: "invoice" },
  }).returning();
  invoiceId = invoice.id;
  await db.insert(invoiceAcompteApplications).values({
    invoiceId, devisId: devisRow.id, certificatId: certificat.id, sourceIntakeDocumentId: source.id,
    sourceStorageKey: source.storageKey, sourceFileName: source.fileName,
    sourceContentFingerprint: source.contentFingerprint!, appliedHt: "10.00", appliedTtc: "12.00",
    invoiceGrossHt: "100.00", invoiceGrossTtc: "120.00", invoiceNetPayableTtc: "108.00",
    evidenceText: "Acompte versé",
  });
  const [raceSource] = await db.insert(projectIntakeDocuments).values({
    projectId: project.id, fileName: "race.pdf", storageKey: `tests/race-${nonce}.pdf`,
    contentFingerprint: "b".repeat(64), extractedData: { documentType: "invoice" },
  }).returning();
  const [raceInvoice] = await db.insert(invoices).values({
    projectId: project.id, contractorId: contractor.id, devisId: devisRow.id,
    sourceIntakeDocumentId: raceSource.id, invoiceNumber: `RACE-I-${nonce}`,
    amountHt: "100.00", tvaAmount: "20.00", amountTtc: "120.00",
  }).returning();
  raceInvoiceId = raceInvoice.id;
  const [certificateSourceInvoice] = await db.insert(invoices).values({
    projectId: project.id,
    contractorId: contractor.id,
    devisId: devisRow.id,
    invoiceNumber: `CERT-SOURCE-I-${nonce}`,
    amountHt: "50.00",
    tvaAmount: "10.00",
    amountTtc: "60.00",
    status: "draft",
    aiExtractedData: { documentType: "invoice" },
  }).returning();
  certificateSourceInvoiceId = certificateSourceInvoice.id;
  await db.insert(certificatSources).values({
    certificatId: certificat.id,
    invoiceId: certificateSourceInvoice.id,
  });
  const [supersededCertificat] = await db.insert(certificats).values({
    projectId: project.id, contractorId: contractor.id,
    certificateRef: `SEAL-SUPERSEDED-C-${nonce}`, dateIssued: "2026-01-01",
    totalWorksHt: "25.00", pvMvAdjustment: "0.00", previousPayments: "0.00",
    retenueGarantie: "0.00", cumulativeProrataDeduction: "0.00",
    periodProrataDeduction: "0.00", cumulativeAcompteRecoupment: "0.00",
    periodAcompteRecoupment: "0.00", netToPayHt: "25.00", tvaAmount: "5.00",
    netToPayTtc: "30.00", status: "superseded",
  }).returning();
  const [supersededSourceInvoice] = await db.insert(invoices).values({
    projectId: project.id, contractorId: contractor.id, devisId: devisRow.id,
    invoiceNumber: `SUPERSEDED-SOURCE-I-${nonce}`, amountHt: "25.00",
    tvaAmount: "5.00", amountTtc: "30.00", status: "draft",
  }).returning();
  supersededSourceInvoiceId = supersededSourceInvoice.id;
  await db.insert(certificatSources).values({
    certificatId: supersededCertificat.id,
    invoiceId: supersededSourceInvoice.id,
  });

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as typeof req & { session: { userId: number } }).session = { userId: 1 };
    next();
  });
  app.use(rematchRouter);
  app.use(invoicesRouter);
  server = await new Promise<http.Server>((resolve) => {
    const value = app.listen(0, () => resolve(value));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!projectId) return;
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.allow_acompte_application_delete', 'true', true)`);
    await tx.delete(invoiceAcompteApplications).where(eq(invoiceAcompteApplications.invoiceId, invoiceId));
    await tx.delete(projects).where(eq(projects.id, projectId));
  });
  if (contractorId) await db.delete(contractors).where(eq(contractors.id, contractorId));
});

describe("applied invoice seal and rematch", () => {
  async function expectInvoiceSeal(promise: Promise<unknown>): Promise<void> {
    try {
      await promise;
      throw new Error("Expected the applied invoice seal to reject the write");
    } catch (error) {
      const messages: string[] = [];
      let current: unknown = error;
      while (current && typeof current === "object") {
        if ("message" in current && typeof current.message === "string") messages.push(current.message);
        current = "cause" in current ? current.cause : null;
      }
      expect(messages.join("\n")).toContain("invoice_acompte_invoice_sealed");
    }
  }

  async function expectCertificateSourceSeal(promise: Promise<unknown>): Promise<void> {
    try {
      await promise;
      throw new Error("Expected the certificate source seal to reject the write");
    } catch (error) {
      const messages: string[] = [];
      let current: unknown = error;
      while (current && typeof current === "object") {
        if ("message" in current && typeof current.message === "string") messages.push(current.message);
        current = "cause" in current ? current.cause : null;
      }
      expect(messages.join("\n")).toContain("invoice_certificate_source_immutable");
    }
  }

  it("skips an applied invoice in admin rematch instead of attempting the protected update", async () => {
    const response = await fetch(`${base}/api/admin/invoice-rematch/apply`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ invoiceIds: [invoiceId] }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      applied: [],
      skipped: [{ invoiceId, reason: expect.stringContaining("applied opening-deposit") }],
    });
  });

  it("skips certificate source evidence in admin rematch", async () => {
    const response = await fetch(`${base}/api/admin/invoice-rematch/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ invoiceIds: [certificateSourceInvoiceId] }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      applied: [],
      skipped: [
        {
          invoiceId: certificateSourceInvoiceId,
          reason: expect.stringContaining("active payment certificate"),
        },
      ],
    });
  });

  it("refuses confirmation corrections once an invoice is certificate evidence", async () => {
    const response = await fetch(`${base}/api/invoices/${certificateSourceInvoiceId}/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amountHt: 55, amountTtc: 66 }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "invoice_certificate_source_immutable",
    });
    const [invoice] = await db
      .select()
      .from(invoices)
      .where(eq(invoices.id, certificateSourceInvoiceId));
    expect(invoice.amountHt).toBe("50.00");
    expect(invoice.amountTtc).toBe("60.00");
  });

  it("enforces applied invoice economic and provenance immutability in the database", async () => {
    await expectInvoiceSeal(db.update(invoices).set({ amountHt: "101.00" }).where(eq(invoices.id, invoiceId)));
    await expectInvoiceSeal(db.delete(invoices).where(eq(invoices.id, invoiceId)));
    await expectInvoiceSeal(db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.allow_acompte_application_delete', 'true', true)`);
      await tx.update(invoices).set({ amountTtc: "121.00" }).where(eq(invoices.id, invoiceId));
    }));
  });

  it("enforces active certificate source immutability in the database", async () => {
    await expectCertificateSourceSeal(
      db.update(invoices).set({ amountHt: "51.00" }).where(eq(invoices.id, certificateSourceInvoiceId)),
    );
    await expectCertificateSourceSeal(
      db.update(invoices).set({ contractorId: contractorId + 1 }).where(eq(invoices.id, certificateSourceInvoiceId)),
    );
    await expectCertificateSourceSeal(
      db.delete(invoices).where(eq(invoices.id, certificateSourceInvoiceId)),
    );
  });

  it("allows mutation when every certificate source reference is superseded", async () => {
    await expect(
      db.update(invoices)
        .set({ amountHt: "26.00" })
        .where(eq(invoices.id, supersededSourceInvoiceId))
        .returning({ amountHt: invoices.amountHt }),
    ).resolves.toEqual([{ amountHt: "26.00" }]);
  });

  it("serialises a source claim against a concurrent protected mutation", async () => {
    const [raceTarget] = await db.insert(invoices).values({
      projectId, contractorId, devisId: (await db.select({ id: devis.id }).from(devis)
        .where(eq(devis.projectId, projectId)).limit(1))[0].id,
      invoiceNumber: `SOURCE-RACE-${Date.now()}`, amountHt: "10.00",
      tvaAmount: "2.00", amountTtc: "12.00",
    }).returning();

    let releaseClaim!: () => void;
    const claimCanCommit = new Promise<void>((resolve) => { releaseClaim = resolve; });
    let claimInserted!: () => void;
    const inserted = new Promise<void>((resolve) => { claimInserted = resolve; });
    const claim = db.transaction(async (tx) => {
      await tx.insert(certificatSources).values({
        certificatId: certificateId,
        invoiceId: raceTarget.id,
      });
      claimInserted();
      await claimCanCommit;
    });
    await inserted;

    let mutationSettled = false;
    const mutation = Promise.resolve(
      db.update(invoices)
        .set({ amountHt: "11.00" })
        .where(eq(invoices.id, raceTarget.id)),
    ).finally(() => {
      mutationSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(mutationSettled).toBe(false);

    releaseClaim();
    await claim;
    await expectCertificateSourceSeal(mutation);
  });

  it("refuses application when the prepared protected snapshot loses a race", async () => {
    const [prepared] = await db.select().from(invoices).where(eq(invoices.id, raceInvoiceId));
    const snapshot = invoiceAcompteProtectedSnapshot(prepared);
    await db.update(invoices).set({ amountHt: "101.00" }).where(eq(invoices.id, raceInvoiceId));
    await expect(applyInvoiceAcompteDeduction(raceInvoiceId, snapshot)).resolves.toMatchObject({
      outcome: "needs_review", code: "invoice_acompte_snapshot_changed",
    });
  });
});