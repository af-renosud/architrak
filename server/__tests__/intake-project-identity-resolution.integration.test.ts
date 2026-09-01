import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import {
  contractors,
  devis,
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
});