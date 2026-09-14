import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import {
  acompteNoInvoicePayments,
  certificats,
  contractors,
  devis,
  invoiceAcompteApplications,
  invoices,
  intakeProjectIdentityResolutions,
  projectDocuments,
  projectIntakeDocuments,
  projects,
  users,
} from "@shared/schema";

vi.mock("../auth/middleware", () => ({
  requireAuth: (req: { session?: { userId?: number } }, _res: unknown, next: () => void) => {
    req.session = { userId: testUserId };
    next();
  },
}));

vi.mock("../services/intake/ingest-queue.service", () => ({
  enqueueIntakeJob: vi.fn(async () => undefined),
  requeueIntakeDocument: vi.fn(async () => true),
}));

vi.mock("../storage/object-storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../storage/object-storage")>();
  return {
    ...actual,
    uploadDocument: vi.fn(async () => `tests/mock-invoice-${Date.now()}-${Math.random()}.pdf`),
  };
});

import intakeRouter from "../routes/intake";
import { processInvoiceUpload } from "../services/invoice-upload.service";
import { confirmNoInvoiceAcomptePayment } from "../services/acompte.service";
import { getProjectFinancialSummary } from "../services/financial-summary.service";
import { storage } from "../storage";

const fingerprint = "a".repeat(64);
let testUserId = 0;
let projectId = 0;
let otherProjectId = 0;
let otherProjectName = "";
let archivedProjectId = 0;
let server: http.Server;
let base = "";

async function createDoc(overrides: Partial<typeof projectIntakeDocuments.$inferInsert> = {}) {
  const [doc] = await db.insert(projectIntakeDocuments).values({
    projectId,
    fileName: "FR25.26-0144.pdf",
    storageKey: "tests/intake-project-identity/FR25.26-0144.pdf",
    contentFingerprint: fingerprint,
    analysisState: "analyzed",
    routingState: "parked",
    extractedData: {
      preParsedFromEmail: true,
      documentType: "invoice",
      projectName: "VERFEUIL Projet Heinz Hermann Trütken - 406 chemin de la grange",
    },
    notes: "Invoice parked: labelled project identity is unresolved or conflicting.",
    ...overrides,
  }).returning();
  return doc;
}

const post = (path: string, body: unknown) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

beforeAll(async () => {
  const uniq = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const [user] = await db.insert(users).values({
    googleId: `t688-${uniq}`,
    email: `t688-${uniq}@local.test`,
  }).returning();
  testUserId = user.id;
  const insertedProjects = await db.insert(projects).values([
    { code: `T688-${uniq}-A`.slice(0, 50), name: `TRÜTKEN (VERFEUIL) ${uniq}`, clientName: "Identity review" },
    { code: `T688-${uniq}-B`.slice(0, 50), name: `Other project ${uniq}`, clientName: "Identity review" },
    {
      code: `T688-${uniq}-C`.slice(0, 50),
      name: `Archived project ${uniq}`,
      clientName: "Identity review",
      archivedAt: new Date(),
    },
  ]).returning();
  [projectId, otherProjectId, archivedProjectId] = insertedProjects.map((project) => project.id);
  otherProjectName = insertedProjects[1].name;

  const app = express();
  app.use(express.json());
  app.use(intakeRouter);
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ message: err instanceof Error ? err.message : "error" });
  });
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.allow_intake_project_identity_resolution_delete', 'true', true)`);
    await tx.delete(intakeProjectIdentityResolutions).where(
      sql`${intakeProjectIdentityResolutions.projectId} IN (${projectId}, ${otherProjectId}, ${archivedProjectId})`,
    );
  });
  await db.delete(projectIntakeDocuments).where(
    sql`${projectIntakeDocuments.projectId} IN (${projectId}, ${otherProjectId}, ${archivedProjectId})`,
  );
  await db.delete(projects).where(sql`${projects.id} IN (${projectId}, ${otherProjectId}, ${archivedProjectId})`);
  await db.delete(users).where(eq(users.id, testUserId));
});

describe("fingerprint-bound intake project identity confirmation", () => {
  it("records one immutable audit under concurrent replay and derives the actor from the session", async () => {
    const doc = await createDoc();
    const request = { confirmed: true, expectedFingerprint: fingerprint };
    const [first, second] = await Promise.all([
      post(`/api/intake-documents/${doc.id}/confirm-project-identity`, request),
      post(`/api/intake-documents/${doc.id}/confirm-project-identity`, request),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 201]);
    const rows = await db.select().from(intakeProjectIdentityResolutions).where(
      eq(intakeProjectIdentityResolutions.intakeDocumentId, doc.id),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      projectId,
      sourceContentFingerprint: fingerprint,
      sourceStorageKey: doc.storageKey,
      sourceFileName: doc.fileName,
      confirmedByUserId: testUserId,
      labelledProjectName: "VERFEUIL Projet Heinz Hermann Trütken - 406 chemin de la grange",
    });
    await expect(
      db.update(intakeProjectIdentityResolutions)
        .set({ labelledProjectName: "tampered" })
        .where(eq(intakeProjectIdentityResolutions.id, rows[0].id)),
    ).rejects.toThrow(/Failed query/);
  });

  it("rejects a stale or changed source fingerprint", async () => {
    const doc = await createDoc({ contentFingerprint: "b".repeat(64) });
    const response = await post(`/api/intake-documents/${doc.id}/confirm-project-identity`, {
      confirmed: true,
      expectedFingerprint: fingerprint,
    });
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("stale_source_fingerprint");
  });

  it("rejects archived projects, already-routed documents, and documents with no labelled identity", async () => {
    const archivedDoc = await createDoc({ projectId: archivedProjectId });
    const routedDoc = await createDoc({ routingState: "routed", promotedKind: "invoice", promotedId: 999_999 });
    const unlabelledDoc = await createDoc({ extractedData: { documentType: "invoice" } });
    const [archived, routed, unlabelled] = await Promise.all([
      post(`/api/intake-documents/${archivedDoc.id}/confirm-project-identity`, { confirmed: true, expectedFingerprint: fingerprint }),
      post(`/api/intake-documents/${routedDoc.id}/confirm-project-identity`, { confirmed: true, expectedFingerprint: fingerprint }),
      post(`/api/intake-documents/${unlabelledDoc.id}/confirm-project-identity`, { confirmed: true, expectedFingerprint: fingerprint }),
    ]);
    expect(archived.status).toBe(409);
    expect((await archived.json()).code).toBe("project_archived");
    expect(routed.status).toBe(409);
    expect((await routed.json()).code).toBe("project_resolution_invalid_state");
    expect(unlabelled.status).toBe(422);
    expect((await unlabelled.json()).code).toBe("project_resolution_no_label");
  });

  it("refuses to override a label that exactly belongs to another live project", async () => {
    const doc = await createDoc({
      extractedData: { documentType: "invoice", projectName: otherProjectName },
    });
    const response = await post(`/api/intake-documents/${doc.id}/confirm-project-identity`, {
      confirmed: true,
      expectedFingerprint: fingerprint,
    });
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("project_resolution_wrong_project");
    const rows = await db.select().from(intakeProjectIdentityResolutions).where(
      eq(intakeProjectIdentityResolutions.intakeDocumentId, doc.id),
    );
    expect(rows).toHaveLength(0);
  });

  it("refuses a resolution audit that belongs to a different project", async () => {
    const doc = await createDoc();
    await db.insert(intakeProjectIdentityResolutions).values({
      intakeDocumentId: doc.id,
      projectId: otherProjectId,
      sourceStorageKey: doc.storageKey,
      sourceFileName: doc.fileName,
      sourceContentFingerprint: fingerprint,
      labelledProjectName: "Conflicting project",
      confirmedByUserId: testUserId,
    });
    const response = await post(`/api/intake-documents/${doc.id}/confirm-project-identity`, {
      confirmed: true,
      expectedFingerprint: fingerprint,
    });
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("project_resolution_conflict");
    const [row] = await db.select().from(intakeProjectIdentityResolutions).where(and(
      eq(intakeProjectIdentityResolutions.intakeDocumentId, doc.id),
      eq(intakeProjectIdentityResolutions.sourceContentFingerprint, fingerprint),
    ));
    expect(row.projectId).toBe(otherProjectId);
  });

  it("creates one source-keyed invoice when two routing workers race", async () => {
    const [contractor] = await db.insert(contractors).values({
      name: `T688 concurrent contractor ${Date.now()}`,
    }).returning();
    const [quotation] = await db.insert(devis).values({
      projectId,
      contractorId: contractor.id,
      devisCode: `T688-CONCURRENT-${Date.now()}`,
      descriptionFr: "Concurrent intake routing",
      amountHt: "1000.00",
      amountTtc: "1200.00",
      acompteRequired: false,
    }).returning();
    const source = await createDoc({
      fileName: "concurrent-source.pdf",
      storageKey: "tests/concurrent-source.pdf",
      contentFingerprint: "c".repeat(64),
      extractedData: { documentType: "invoice", invoiceNumber: "T688-RACE", amountHt: 500, amountTtc: 600 },
    });
    const parsed = {
      documentType: "invoice" as const,
      invoiceNumber: "T688-RACE",
      amountHt: 500,
      amountTtc: 600,
      date: "2026-08-20",
    };
    const file = {
      originalname: source.fileName,
      mimetype: "application/pdf",
      buffer: Buffer.from("%PDF-1.4\n%%EOF"),
    };
    try {
      const [first, second] = await Promise.all([
        processInvoiceUpload(quotation.id, file, parsed, { sourceIntakeDocumentId: source.id }),
        processInvoiceUpload(quotation.id, file, parsed, { sourceIntakeDocumentId: source.id }),
      ]);
      expect(first.success).toBe(true);
      expect(second.success).toBe(true);
      expect((first.data as { invoice: { id: number } }).invoice.id)
        .toBe((second.data as { invoice: { id: number } }).invoice.id);
      const rows = await db.select().from(invoices).where(eq(invoices.sourceIntakeDocumentId, source.id));
      expect(rows).toHaveLength(1);
      const docs = await db.select().from(projectDocuments).where(eq(projectDocuments.projectId, projectId));
      expect(docs.filter((doc) => doc.fileName === source.fileName)).toHaveLength(1);
    } finally {
      await db.delete(invoices).where(eq(invoices.sourceIntakeDocumentId, source.id));
      await db.delete(projectDocuments).where(and(
        eq(projectDocuments.projectId, projectId),
        eq(projectDocuments.fileName, source.fileName),
      ));
      await db.delete(projectIntakeDocuments).where(eq(projectIntakeDocuments.id, source.id));
      await db.delete(devis).where(eq(devis.id, quotation.id));
      await db.delete(contractors).where(eq(contractors.id, contractor.id));
    }
  });

  it("rolls back the invoice when its project-document write fails, then allows a clean retry", async () => {
    const [contractor] = await db.insert(contractors).values({
      name: `T688 atomic contractor ${Date.now()}`,
    }).returning();
    const [quotation] = await db.insert(devis).values({
      projectId,
      contractorId: contractor.id,
      devisCode: `T688-ATOMIC-${Date.now()}`,
      descriptionFr: "Atomic intake routing",
      amountHt: "1000.00",
      amountTtc: "1200.00",
      acompteRequired: false,
    }).returning();
    const source = await createDoc({
      fileName: "atomic-source.pdf",
      storageKey: "tests/atomic-source.pdf",
      contentFingerprint: "d".repeat(64),
    });
    const invoiceData = {
      devisId: quotation.id,
      contractorId: contractor.id,
      projectId,
      sourceIntakeDocumentId: source.id,
      invoiceNumber: "T688-ATOMIC",
      amountHt: "500.00",
      tvaAmount: "100.00",
      amountTtc: "600.00",
      status: "draft",
    };
    const projectDocumentData = {
      projectId,
      fileName: source.fileName,
      storageKey: "tests/atomic-routed.pdf",
      documentType: "invoice",
      uploadedBy: "test",
    };
    try {
      await expect(storage.createIntakeInvoiceWithProjectDocument(
        invoiceData,
        { ...projectDocumentData, fileName: null as unknown as string },
      )).rejects.toThrow();
      expect(await db.select().from(invoices).where(eq(invoices.sourceIntakeDocumentId, source.id))).toHaveLength(0);

      const retry = await storage.createIntakeInvoiceWithProjectDocument(invoiceData, projectDocumentData);
      expect(retry.created).toBe(true);
      expect(await db.select().from(invoices).where(eq(invoices.sourceIntakeDocumentId, source.id))).toHaveLength(1);
      const docs = await db.select().from(projectDocuments).where(and(
        eq(projectDocuments.projectId, projectId),
        eq(projectDocuments.fileName, source.fileName),
      ));
      expect(docs).toHaveLength(1);
    } finally {
      await db.delete(invoices).where(eq(invoices.sourceIntakeDocumentId, source.id));
      await db.delete(projectDocuments).where(and(
        eq(projectDocuments.projectId, projectId),
        eq(projectDocuments.fileName, source.fileName),
      ));
      await db.delete(projectIntakeDocuments).where(eq(projectIntakeDocuments.id, source.id));
      await db.delete(devis).where(eq(devis.id, quotation.id));
      await db.delete(contractors).where(eq(contractors.id, contractor.id));
    }
  });

  it("never routes a guarded source by reusing a typed invoice with a different financial identity", async () => {
    const suffix = Date.now();
    const [targetContractor, wrongContractor] = await db.insert(contractors).values([
      { name: `T688 guarded target contractor ${suffix}` },
      { name: `T688 guarded wrong contractor ${suffix}` },
    ]).returning();
    const [quotation] = await db.insert(devis).values({
      projectId,
      contractorId: targetContractor.id,
      devisCode: `T688-GUARD-${suffix}`,
      descriptionFr: "Guarded source identity",
      amountHt: "1000.00",
      amountTtc: "1200.00",
      acompteRequired: false,
    }).returning();
    const source = await createDoc({
      fileName: `guarded-conflict-${suffix}.pdf`,
      storageKey: `tests/guarded-conflict-${suffix}.pdf`,
      contentFingerprint: "f".repeat(64),
      analysisState: "analyzing",
      routingState: "unrouted",
      extractedData: {
        documentType: "invoice",
        relatedDocumentReferences: [{
          kind: "quotation",
          reference: quotation.devisCode,
          evidenceText: `Devis ${quotation.devisCode}`,
        }],
      },
    });
    try {
      // This simulates a corrupted/historical source-key winner.  The unique
      // key alone must never authorize promotion to the resolver's target.
      await db.insert(invoices).values({
        projectId,
        contractorId: wrongContractor.id,
        devisId: quotation.id,
        sourceIntakeDocumentId: source.id,
        invoiceNumber: `T688-WRONG-${suffix}`,
        amountHt: "500.00",
        tvaAmount: "100.00",
        amountTtc: "600.00",
        status: "draft",
      });
      await expect(storage.createIntakeInvoiceWithProjectDocument({
        projectId,
        contractorId: targetContractor.id,
        devisId: quotation.id,
        sourceIntakeDocumentId: source.id,
        invoiceNumber: `T688-RIGHT-${suffix}`,
        amountHt: "500.00",
        tvaAmount: "100.00",
        amountTtc: "600.00",
        status: "draft",
      }, {
        projectId,
        fileName: source.fileName,
        storageKey: source.storageKey,
        documentType: "invoice",
        uploadedBy: "test",
      }, {
        sourceContentFingerprint: source.contentFingerprint!,
        contractorId: targetContractor.id,
        expectedDevisId: quotation.id,
        expectedResolutionKey: `resolved:${quotation.id}:quotation`,
        intakeNote: "Must not route conflicting source winner",
      })).rejects.toThrow(/Existing source invoice identity conflicts/);
      expect(await storage.getProjectIntakeDocument(source.id)).toMatchObject({
        analysisState: "analyzing",
        routingState: "unrouted",
        promotedId: null,
      });
    } finally {
      await db.delete(invoices).where(eq(invoices.sourceIntakeDocumentId, source.id));
      await db.delete(projectIntakeDocuments).where(eq(projectIntakeDocuments.id, source.id));
      await db.delete(devis).where(eq(devis.id, quotation.id));
      await db.delete(contractors).where(eq(contractors.id, targetContractor.id));
      await db.delete(contractors).where(eq(contractors.id, wrongContractor.id));
    }
  });

  it("does not route a progress invoice when a pending acompte is armed before final guarded promotion", async () => {
    const suffix = Date.now();
    const [contractor] = await db.insert(contractors).values({
      name: `T739 final-route gate contractor ${suffix}`,
    }).returning();
    const [quotation] = await db.insert(devis).values({
      projectId,
      contractorId: contractor.id,
      devisCode: `T739-GATE-${suffix}`,
      descriptionFr: "Final guarded deposit gate",
      amountHt: "1000.00",
      amountTtc: "1200.00",
      acompteRequired: true,
      acompteAmountHt: "200.00",
      acompteState: "pending",
    }).returning();
    const source = await createDoc({
      fileName: `final-route-gate-${suffix}.pdf`,
      storageKey: `tests/final-route-gate-${suffix}.pdf`,
      contentFingerprint: "g".repeat(64),
      analysisState: "analyzing",
      routingState: "unrouted",
      extractedData: {
        documentType: "invoice",
        relatedDocumentReferences: [{
          kind: "quotation",
          reference: quotation.devisCode,
          evidenceText: `Devis ${quotation.devisCode}`,
        }],
      },
    });
    try {
      await expect(storage.createIntakeInvoiceWithProjectDocument({
        projectId,
        contractorId: contractor.id,
        devisId: quotation.id,
        sourceIntakeDocumentId: source.id,
        invoiceNumber: `T739-PROGRESS-${suffix}`,
        amountHt: "500.00",
        tvaAmount: "100.00",
        amountTtc: "600.00",
        status: "draft",
        aiExtractedData: { documentType: "invoice" },
      }, {
        projectId,
        fileName: source.fileName,
        storageKey: source.storageKey,
        documentType: "invoice",
        uploadedBy: "test",
      }, {
        sourceContentFingerprint: source.contentFingerprint!,
        contractorId: contractor.id,
        expectedDevisId: quotation.id,
        expectedResolutionKey: `resolved:${quotation.id}:quotation`,
        intakeNote: "Final promotion must re-check acompte gate",
      }, { routeSource: true })).rejects.toThrow(/Acompte gate became blocking/);

      expect(await db.select().from(invoices)
        .where(eq(invoices.sourceIntakeDocumentId, source.id))).toHaveLength(0);
      expect(await storage.getProjectIntakeDocument(source.id)).toMatchObject({
        analysisState: "analyzing",
        routingState: "unrouted",
        promotedId: null,
      });
    } finally {
      await db.delete(invoices).where(eq(invoices.sourceIntakeDocumentId, source.id));
      await db.delete(projectDocuments).where(and(
        eq(projectDocuments.projectId, projectId),
        eq(projectDocuments.fileName, source.fileName),
      ));
      await db.delete(projectIntakeDocuments).where(eq(projectIntakeDocuments.id, source.id));
      await db.delete(devis).where(eq(devis.id, quotation.id));
      await db.delete(contractors).where(eq(contractors.id, contractor.id));
    }
  });

  it("routes an evidenced paid deposit through one application across two progress invoices and a final invoice", async () => {
    const suffix = Date.now();
    const [contractor] = await db.insert(contractors).values({
      name: `T688 deposit lifecycle contractor ${suffix}`,
    }).returning();
    const [quotation] = await db.insert(devis).values({
      projectId,
      contractorId: contractor.id,
      devisCode: `T688-DEP-${suffix}`,
      descriptionFr: "Opening deposit then staged works",
      amountHt: "10000.00",
      amountTtc: "12000.00",
      acompteRequired: true,
      acompteAmountHt: "2000.00",
      acompteState: "pending",
      signOffStage: "client_signed_off",
      accountingState: "active",
    }).returning();
    const sourceExtraction = {
      documentType: "invoice" as const,
      projectId,
      contractorId: contractor.id,
      devisId: quotation.id,
      devisCode: quotation.devisCode,
      invoiceNumber: `T688-P1-${suffix}`,
      amountHt: 5000,
      amountTtc: 6000,
      netAPayer: 3600,
      acomptePaidAmountTtc: 2400,
      acomptePaidEvidenceText: "Acompte versé 2 400,00 €",
      relatedDocumentReferences: [{
        kind: "quotation" as const,
        reference: quotation.devisCode,
        evidenceText: `Devis ${quotation.devisCode}`,
      }],
    };
    const source = await createDoc({
      fileName: `deposit-progress-${suffix}.pdf`,
      storageKey: `tests/deposit-progress-${suffix}.pdf`,
      contentFingerprint: "e".repeat(64),
      analysisState: "analyzing",
      routingState: "unrouted",
      extractedData: sourceExtraction,
    });
    let certificateId: number | null = null;
    let firstInvoiceId: number | null = null;
    let secondInvoiceId: number | null = null;
    let finalInvoiceId: number | null = null;
    try {
      // This is explicit operator-confirmed supplier-payment evidence; no
      // invoice date, certificate-payment ledger entry, or inferred money is
      // used to advance pending → paid.
      const payment = await confirmNoInvoiceAcomptePayment({
        devisId: quotation.id,
        sourceIntakeDocumentId: source.id,
        paidAt: new Date("2024-01-15T12:00:00.000Z"),
        paymentReference: `SUPPLIER-DEPOSIT-${suffix}`,
        confirmedByUserId: testUserId,
      });
      expect(payment.outcome).toBe("ok");
      if (payment.outcome !== "ok") throw new Error("Expected explicit deposit payment confirmation");
      certificateId = payment.certificatId;
      expect((await storage.getDevis(quotation.id))?.acompteState).toBe("paid");

      const parsed = {
        ...sourceExtraction,
      };
      // A financial mismatch may persist a recoverable typed invoice, but
      // cannot make the source look routed. The next retry below is therefore
      // able to apply only after the evidence itself is corrected.
      await db.update(projectIntakeDocuments).set({
        extractedData: { ...sourceExtraction, acomptePaidAmountTtc: 2399 },
      }).where(eq(projectIntakeDocuments.id, source.id));
      const review = await processInvoiceUpload(quotation.id, {
        originalname: source.fileName,
        mimetype: "application/pdf",
        buffer: Buffer.from("%PDF-1.4\n%%EOF"),
      }, { ...parsed, acomptePaidAmountTtc: 2399 }, {
        sourceIntakeDocumentId: source.id,
        relationshipGuard: {
          sourceContentFingerprint: source.contentFingerprint!,
          contractorId: contractor.id,
          expectedDevisId: quotation.id,
          expectedResolutionKey: `resolved:${quotation.id}:quotation`,
          intakeNote: "Tested explicit relationship route",
        },
      });
      expect(review).toMatchObject({ success: false, status: 409 });
      expect(await storage.getProjectIntakeDocument(source.id)).toMatchObject({
        analysisState: "analyzing",
        routingState: "unrouted",
        promotedId: null,
      });
      expect(await db.select().from(invoiceAcompteApplications)
        .where(eq(invoiceAcompteApplications.devisId, quotation.id))).toHaveLength(0);
      await db.update(projectIntakeDocuments).set({ extractedData: sourceExtraction })
        .where(eq(projectIntakeDocuments.id, source.id));

      const routed = await processInvoiceUpload(quotation.id, {
        originalname: source.fileName,
        mimetype: "application/pdf",
        buffer: Buffer.from("%PDF-1.4\n%%EOF"),
      }, parsed, {
        sourceIntakeDocumentId: source.id,
        relationshipGuard: {
          sourceContentFingerprint: source.contentFingerprint!,
          contractorId: contractor.id,
          expectedDevisId: quotation.id,
          expectedResolutionKey: `resolved:${quotation.id}:quotation`,
          intakeNote: "Tested explicit relationship route",
        },
      });
      expect(routed.success).toBe(true);
      if (!routed.success) throw new Error("Expected source-bound first progress invoice");
      firstInvoiceId = (routed.data as { invoice: { id: number } }).invoice.id;

      const applications = await db.select().from(invoiceAcompteApplications)
        .where(eq(invoiceAcompteApplications.invoiceId, firstInvoiceId));
      expect(applications).toHaveLength(1);
      expect(applications[0]).toMatchObject({
        devisId: quotation.id,
        appliedHt: "2000.00",
        appliedTtc: "2400.00",
        invoiceGrossHt: "5000.00",
        invoiceGrossTtc: "6000.00",
        invoiceNetPayableTtc: "3600.00",
      });
      expect((await storage.getDevis(quotation.id))?.acompteState).toBe("applied");

      const second = await storage.createInvoice({
        projectId,
        contractorId: contractor.id,
        devisId: quotation.id,
        invoiceNumber: `T688-P2-${suffix}`,
        amountHt: "3000.00",
        tvaAmount: "600.00",
        amountTtc: "3600.00",
        status: "draft",
      });
      secondInvoiceId = second.id;
      const final = await storage.createInvoice({
        projectId,
        contractorId: contractor.id,
        devisId: quotation.id,
        invoiceNumber: `T688-FINAL-${suffix}`,
        amountHt: "2000.00",
        tvaAmount: "400.00",
        amountTtc: "2400.00",
        status: "draft",
      });
      finalInvoiceId = final.id;

      const summary = await getProjectFinancialSummary(projectId);
      expect(summary.success).toBe(true);
      if (!summary.success) throw new Error("Expected financial summary");
      const row = summary.data.devis.find((item) => item.devisId === quotation.id);
      expect(row).toMatchObject({
        invoiceCount: 3,
        certifiedHt: 10000,
        certifiedTtc: 12000,
        acompteCertifiedHt: 0,
        acompteCertifiedTtc: 0,
        acompteAppliedHt: 2000,
        acompteAppliedTtc: 2400,
        currentInvoiceBalanceTtc: 3600,
        resteARealiser: 0,
        resteARealiserTtc: 0,
      });
    } finally {
      await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.allow_acompte_application_delete', 'true', true)`);
        await tx.delete(invoiceAcompteApplications).where(eq(invoiceAcompteApplications.devisId, quotation.id));
        await tx.execute(sql`SELECT set_config('app.allow_acompte_audit_delete', 'true', true)`);
        await tx.delete(acompteNoInvoicePayments).where(eq(acompteNoInvoicePayments.devisId, quotation.id));
      });
      if (firstInvoiceId != null || secondInvoiceId != null || finalInvoiceId != null) {
        await db.delete(invoices).where(eq(invoices.devisId, quotation.id));
      }
      if (certificateId != null) await db.delete(certificats).where(eq(certificats.id, certificateId));
      await db.delete(projectDocuments).where(and(
        eq(projectDocuments.projectId, projectId),
        eq(projectDocuments.fileName, source.fileName),
      ));
      await db.delete(projectIntakeDocuments).where(eq(projectIntakeDocuments.id, source.id));
      await db.delete(devis).where(eq(devis.id, quotation.id));
      await db.delete(contractors).where(eq(contractors.id, contractor.id));
    }
  });
});