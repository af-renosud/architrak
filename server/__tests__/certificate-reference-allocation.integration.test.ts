import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import http from "http";
import type { AddressInfo } from "net";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  acompteNoInvoicePayments,
  certificatSources,
  certificats,
  contractors,
  devis,
  invoices,
  projectIntakeDocuments,
  projects,
  users,
} from "@shared/schema";
import { db, pool } from "../db";
import { storage } from "../storage";
import acompteRouter from "../routes/acompte";
import certificatsRouter from "../routes/certificats";
import { confirmNoInvoiceAcomptePayment } from "../services/acompte.service";
import { createCertificatFromInvoices } from "../services/certificat-from-invoices.service";

vi.mock("../auth/middleware", () => ({
  requireAuth: (
    req: { session?: { userId?: number } },
    _res: unknown,
    next: () => void,
  ) => {
    req.session ??= {};
    req.session.userId = 1;
    next();
  },
}));

let server: http.Server;
let baseUrl: string;
let projectId: number;
let userId: number;
let invoiceId: number;
const contractorIds: number[] = [];
const devisIds: number[] = [];
let sourceId: number;

const money = {
  totalWorksHt: "100.00",
  pvMvAdjustment: "0.00",
  previousPayments: "0.00",
  retenueGarantie: "0.00",
  cumulativeProrataDeduction: "0.00",
  periodProrataDeduction: "0.00",
  cumulativeAcompteRecoupment: "0.00",
  periodAcompteRecoupment: "0.00",
  tvaRatePercent: "20.00",
  tvaAutoliquidation: false,
  tvaRateSource: "documentary" as const,
  netToPayHt: "100.00",
  tvaAmount: "20.00",
  netToPayTtc: "120.00",
};

beforeAll(async () => {
  const stamp = Date.now();
  const [project] = await db
    .insert(projects)
    .values({
      code: `CERT-REF-${stamp}`,
      name: "Concurrent certificate reference allocation",
      clientName: "Test Client",
      status: "active",
    })
    .returning();
  projectId = project.id;

  const createdContractors = await db
    .insert(contractors)
    .values(
      ["manual", "invoice", "reissue", "deposit-generation", "invoice-free"].map(
        (kind) => ({
          name: `Certificate ref ${kind} ${stamp}`,
          iban: "FR7630006000011234567890189",
        }),
      ),
    )
    .returning();
  contractorIds.push(...createdContractors.map((row) => row.id));

  const [operator] = await db
    .insert(users)
    .values({
      googleId: `certificate-ref-operator-${stamp}`,
      email: `certificate-ref-${stamp}@example.test`,
    })
    .returning();
  userId = operator.id;

  const createdDevis = await db
    .insert(devis)
    .values([
      {
        projectId,
        contractorId: contractorIds[1],
        devisCode: `CERT-REF-INV-${stamp}`,
        descriptionFr: "Invoice-backed certificate",
        amountHt: "100.00",
        amountTtc: "120.00",
        signOffStage: "client_signed_off",
        status: "confirmed",
      },
      {
        projectId,
        contractorId: contractorIds[3],
        devisCode: `CERT-REF-GEN-${stamp}`,
        descriptionFr: "Generated deposit certificate",
        amountHt: "1000.00",
        amountTtc: "1200.00",
        acompteRequired: true,
        acomptePercent: "10.00",
        acompteState: "pending",
        signOffStage: "client_signed_off",
        status: "confirmed",
      },
      {
        projectId,
        contractorId: contractorIds[4],
        devisCode: `CERT-REF-NOINV-${stamp}`,
        descriptionFr: "Invoice-free paid deposit certificate",
        amountHt: "1000.00",
        amountTtc: "1200.00",
        acompteRequired: true,
        acompteAmountHt: "100.00",
        acompteState: "pending",
        signOffStage: "client_signed_off",
        status: "confirmed",
      },
      {
        projectId,
        contractorId: contractorIds[1],
        devisCode: `CERT-REF-MANUAL-${stamp}`,
        descriptionFr: "Manual certificate sharing the invoice contractor",
        amountHt: "100.00",
        amountTtc: "120.00",
        signOffStage: "client_signed_off",
        status: "confirmed",
      },
    ])
    .returning();
  devisIds.push(...createdDevis.map((row) => row.id));

  const [invoice] = await db
    .insert(invoices)
    .values({
      projectId,
      contractorId: contractorIds[1],
      devisId: devisIds[0],
      invoiceNumber: `CERT-REF-INV-${stamp}`,
      amountHt: "100.00",
      tvaAmount: "20.00",
      amountTtc: "120.00",
      status: "approved",
    })
    .returning();
  invoiceId = invoice.id;

  const [source] = await db
    .insert(projectIntakeDocuments)
    .values({
      projectId,
      fileName: "paid-deposit-proof.pdf",
      storageKey: `tests/certificate-reference/${stamp}.pdf`,
      contentFingerprint: stamp.toString().padStart(64, "0"),
      extractedData: {
        documentType: "invoice",
        acomptePaidAmountTtc: 120,
        acomptePaidEvidenceText: "Acompte versé 120 €",
      },
    })
    .returning();
  sourceId = source.id;

  await db.insert(certificats).values({
    projectId,
    contractorId: contractorIds[2],
    certificateRef: "C7",
    ...money,
    status: "sent",
    pdfStorageKey: "tests/certificate-reference/C7.pdf",
    pdfFileName: "C7.pdf",
    issuedAt: new Date(),
  });

  const app = express();
  app.use(express.json());
  app.use(certificatsRouter);
  app.use(acompteRouter);
  app.use(
    (
      error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      res
        .status(500)
        .json({ message: error instanceof Error ? error.message : "error" });
    },
  );
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

});

afterAll(async () => {
  if (server) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('app.allow_acompte_audit_delete', 'true', true)`,
    );
    await tx
      .delete(acompteNoInvoicePayments)
      .where(inArray(acompteNoInvoicePayments.devisId, devisIds));
  });
  const certificateRows = await db
    .select({ id: certificats.id })
    .from(certificats)
    .where(eq(certificats.projectId, projectId));
  if (certificateRows.length > 0) {
    await db
      .delete(certificatSources)
      .where(
        inArray(
          certificatSources.certificatId,
          certificateRows.map((row) => row.id),
        ),
      );
  }
  await db.delete(certificats).where(eq(certificats.projectId, projectId));
  await db.delete(projectIntakeDocuments).where(eq(projectIntakeDocuments.id, sourceId));
  await db.delete(invoices).where(eq(invoices.projectId, projectId));
  await db.delete(devis).where(eq(devis.projectId, projectId));
  await db.delete(contractors).where(inArray(contractors.id, contractorIds));
  await db.delete(users).where(eq(users.id, userId));
  await db.delete(projects).where(eq(projects.id, projectId));
});

describe("project-scoped certificate reference allocation", () => {
  it("keeps concurrent mixed creation paths unique and sequential", async () => {
    const [original] = await db
      .select()
      .from(certificats)
      .where(
        and(
          eq(certificats.projectId, projectId),
          eq(certificats.certificateRef, "C7"),
        ),
      );

    const lockHolder = await pool.connect();
    await lockHolder.query("begin");
    await lockHolder.query("select pg_advisory_xact_lock($1)", [projectId]);

    const creations = [
      fetch(`${baseUrl}/api/projects/${projectId}/certificats`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contractorId: contractorIds[1],
          contextDevisId: devisIds[3],
          dateIssued: "2026-09-09",
          ...money,
          status: "draft",
        }),
      }),
      createCertificatFromInvoices([invoiceId], {
        projectId,
        contractorId: contractorIds[1],
        issueDate: "2026-09-09",
      }),
      storage.reissueCertificat(original.id, {
        projectId,
        contractorId: contractorIds[2],
        ...money,
        status: "draft",
        reissuedFromCertificatId: original.id,
      }),
      fetch(
        `${baseUrl}/api/devis/${devisIds[1]}/acompte/generate-certificat`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        },
      ),
      confirmNoInvoiceAcomptePayment({
        devisId: devisIds[2],
        sourceIntakeDocumentId: sourceId,
        paidAt: new Date("2025-09-09T10:00:00.000Z"),
        paymentReference: "CERT-REF-CONCURRENT",
        confirmedByUserId: userId,
      }),
    ] as const;

    try {
      const waitDeadline = Date.now() + 10_000;
      let waiting = 0;
      while (Date.now() < waitDeadline) {
        const waiterResult = await pool.query<{ count: string }>(
          `select count(*)::text as count
             from pg_locks
            where locktype = 'advisory'
              and classid = 0
              and objid = $1
              and objsubid = 1
              and granted = false`,
          [projectId],
        );
        waiting = Number(waiterResult.rows[0]?.count ?? 0);
        if (waiting === creations.length) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(waiting).toBe(creations.length);
    } finally {
      await lockHolder.query("commit");
      lockHolder.release();
    }

    const completion = Promise.all(creations);
    const [
      manualResponse,
      invoiceBacked,
      reissue,
      generatedDepositResponse,
      invoiceFreeDeposit,
    ] = await Promise.race([
      completion,
      new Promise<never>((_resolve, reject) =>
        setTimeout(
          () => reject(new Error("Mixed certificate creation deadlocked")),
          10_000,
        ),
      ),
    ]);

    expect(manualResponse.status).toBe(201);
    const manual = (await manualResponse.json()) as {
      id: number;
      certificateRef: string;
    };
    expect(generatedDepositResponse.status).toBe(201);
    const generatedDeposit = (await generatedDepositResponse.json()) as {
      id: number;
      certificateRef: string;
    };
    expect(invoiceFreeDeposit.outcome).toBe("ok");
    if (invoiceFreeDeposit.outcome !== "ok") return;

    const [invoiceFreeCertificate] = await db
      .select()
      .from(certificats)
      .where(eq(certificats.id, invoiceFreeDeposit.certificatId));
    const references = [
      manual.certificateRef,
      invoiceBacked.certificateRef,
      reissue.certificateRef,
      generatedDeposit.certificateRef,
      invoiceFreeCertificate.certificateRef,
    ];
    expect(new Set(references).size).toBe(5);
    expect(
      references
        .map((reference) => Number(reference.slice(1)))
        .sort((a, b) => a - b),
    ).toEqual([8, 9, 10, 11, 12]);
  });
});