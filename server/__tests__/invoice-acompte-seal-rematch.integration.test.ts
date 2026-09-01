import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { eq, sql } from "drizzle-orm";
import { db } from "../db";
import {
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

let invoiceId: number;
let raceInvoiceId: number;
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

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as typeof req & { session: { userId: number } }).session = { userId: 1 };
    next();
  });
  app.use(rematchRouter);
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

  it("enforces applied invoice economic and provenance immutability in the database", async () => {
    await expectInvoiceSeal(db.update(invoices).set({ amountHt: "101.00" }).where(eq(invoices.id, invoiceId)));
    await expectInvoiceSeal(db.delete(invoices).where(eq(invoices.id, invoiceId)));
    await expectInvoiceSeal(db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.allow_acompte_application_delete', 'true', true)`);
      await tx.update(invoices).set({ amountTtc: "121.00" }).where(eq(invoices.id, invoiceId));
    }));
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