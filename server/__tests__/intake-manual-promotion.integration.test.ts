import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import {
  benchmarkDocuments,
  contractors,
  devis,
  intakeManualPromotions,
  invoices,
  projectDocuments,
  projectIntakeDocuments,
  projects,
  users,
} from "@shared/schema";

const PDF = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF");
const fingerprint = createHash("sha256").update(PDF).digest("hex");

vi.mock("../storage/object-storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../storage/object-storage")>();
  return { ...actual, getDocumentBuffer: vi.fn(async () => PDF) };
});
vi.mock("../services/devis-translation", () => ({ triggerDevisTranslation: vi.fn() }));
vi.mock("../services/reconciliation/reconciliation-queue.service", () => ({
  enqueueReconciliation: vi.fn(async () => undefined),
}));
vi.mock("../services/advisory-reconciler", () => ({
  reconcileAdvisories: vi.fn(async () => undefined),
}));
vi.mock("../services/drive/upload-queue.service", () => ({
  enqueueDriveUpload: vi.fn(async () => undefined),
}));

import {
  ManualPromotionError,
  promoteParkedFinancialDocument,
} from "../services/intake/manual-promotion.service";
import {
  confirmDevisAndMirror,
  DevisConfirmGuardError,
} from "../services/benchmark-ingest.service";
import { approveInvoice } from "../services/invoice-approval.service";

let userId = 0;
let projectId = 0;
let otherProjectId = 0;
let archivedProjectId = 0;
let contractorId = 0;
let targetDevisId = 0;

async function createSource(
  overrides: Partial<typeof projectIntakeDocuments.$inferInsert> = {},
) {
  const [source] = await db.insert(projectIntakeDocuments).values({
    projectId,
    fileName: "parked-financial.pdf",
    storageKey: `tests/intake-manual-promotion/${Date.now()}-${Math.random()}.pdf`,
    mimeType: "application/pdf",
    contentFingerprint: fingerprint,
    analysisState: "failed",
    routingState: "failed",
    extractedData: {
      documentType: "unknown",
      contractorName: "Extraction unavailable",
      rawText: "PDF rasterisation timed out",
    },
    notes: "PDF rasterisation timed out after all bounded fallbacks.",
    ...overrides,
  }).returning();
  return source;
}

beforeAll(async () => {
  const unique = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const [user] = await db.insert(users).values({
    googleId: `manual-promotion-${unique}`,
    email: `manual-promotion-${unique}@local.test`,
  }).returning();
  userId = user.id;
  const createdProjects = await db.insert(projects).values([
    { code: `MP-${unique}-A`.slice(0, 50), name: `Manual promotion ${unique}`, clientName: "Test" },
    { code: `MP-${unique}-B`.slice(0, 50), name: `Other manual promotion ${unique}`, clientName: "Test" },
    {
      code: `MP-${unique}-C`.slice(0, 50),
      name: `Archived manual promotion ${unique}`,
      clientName: "Test",
      archivedAt: new Date(),
    },
  ]).returning();
  [projectId, otherProjectId, archivedProjectId] = createdProjects.map((row) => row.id);
  const [contractor] = await db.insert(contractors).values({
    name: `Manual promotion contractor ${unique}`,
  }).returning();
  contractorId = contractor.id;
  const [target] = await db.insert(devis).values({
    projectId,
    contractorId,
    devisCode: `MP-TARGET-${unique}`,
    descriptionFr: "Target invoice devis",
    amountHt: "1000.00",
    amountTtc: "1200.00",
    status: "draft",
  }).returning();
  targetDevisId = target.id;
});

afterAll(async () => {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.allow_intake_manual_promotion_delete', 'true', true)`);
    await tx.delete(intakeManualPromotions).where(
      sql`${intakeManualPromotions.projectId} IN (${projectId}, ${otherProjectId}, ${archivedProjectId})`,
    );
  });
  await db.delete(invoices).where(
    sql`${invoices.projectId} IN (${projectId}, ${otherProjectId}, ${archivedProjectId})`,
  );
  await db.delete(benchmarkDocuments).where(eq(benchmarkDocuments.contractorId, contractorId));
  await db.delete(devis).where(
    sql`${devis.projectId} IN (${projectId}, ${otherProjectId}, ${archivedProjectId})`,
  );
  await db.delete(projectDocuments).where(
    sql`${projectDocuments.projectId} IN (${projectId}, ${otherProjectId}, ${archivedProjectId})`,
  );
  await db.delete(projectIntakeDocuments).where(
    sql`${projectIntakeDocuments.projectId} IN (${projectId}, ${otherProjectId}, ${archivedProjectId})`,
  );
  await db.delete(projects).where(
    sql`${projects.id} IN (${projectId}, ${otherProjectId}, ${archivedProjectId})`,
  );
  await db.delete(contractors).where(eq(contractors.id, contractorId));
  await db.delete(users).where(eq(users.id, userId));
});

describe("parked financial document manual promotion", () => {
  it("creates exactly one incomplete devis and immutable audit under concurrent replay", async () => {
    const source = await createSource();
    const input = {
      intakeDocumentId: source.id,
      expectedFingerprint: fingerprint,
      kind: "devis" as const,
      contractorId,
      note: "AI extraction failed repeatedly; route this PDF for manual review.",
      confirmedByUserId: userId,
    };
    const [first, second] = await Promise.all([
      promoteParkedFinancialDocument(input),
      promoteParkedFinancialDocument(input),
    ]);

    expect(first.id).toBe(second.id);
    expect([first.replayed, second.replayed].sort()).toEqual([false, true]);
    const created = await db.select().from(devis).where(eq(devis.sourceIntakeDocumentId, source.id));
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      status: "draft",
      accountingState: "provisional",
      manualIntakeReviewRequired: true,
      contractorId,
      pdfStorageKey: source.storageKey,
    });
    expect(created[0].validationWarnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "manualPromotion", severity: "error" }),
    ]));
    const audits = await db.select().from(intakeManualPromotions).where(
      eq(intakeManualPromotions.intakeDocumentId, source.id),
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      sourceContentFingerprint: fingerprint,
      priorRoutingState: "failed",
      confirmedByUserId: userId,
      promotedId: created[0].id,
    });
    await expect(db.update(intakeManualPromotions)
      .set({ operatorNote: "tampered audit note" })
      .where(eq(intakeManualPromotions.id, audits[0].id))).rejects.toThrow(/Failed query/);
  });

  it("creates a source-linked invoice shell only for an explicit devis in the same project", async () => {
    const source = await createSource({ extractedData: null });
    const result = await promoteParkedFinancialDocument({
      intakeDocumentId: source.id,
      expectedFingerprint: fingerprint,
      kind: "invoice",
      devisId: targetDevisId,
      note: "The supplier confirmed this is an invoice; totals need manual entry.",
      confirmedByUserId: userId,
    });
    const [invoice] = await db.select().from(invoices).where(
      eq(invoices.sourceIntakeDocumentId, source.id),
    );
    expect(result).toMatchObject({ kind: "invoice", id: invoice.id, replayed: false });
    expect(invoice).toMatchObject({
      devisId: targetDevisId,
      contractorId,
      projectId,
      amountHt: "0.00",
      amountTtc: "0.00",
      tvaAmount: "0.00",
      status: "draft",
      manualIntakeReviewRequired: true,
      pdfPath: source.storageKey,
    });
    expect(invoice.validationWarnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "manualPromotion", severity: "error" }),
      expect.objectContaining({ field: "amountHt", severity: "error" }),
    ]));
    await db.update(invoices).set({ status: "pending" }).where(eq(invoices.id, invoice.id));
    await expect(approveInvoice(invoice.id)).resolves.toMatchObject({
      success: false,
      status: 409,
      data: { code: "manual_intake_review_required" },
    });
  });

  it("clears the devis review gate once under lock and only after canonical positive totals", async () => {
    const source = await createSource();
    const promoted = await promoteParkedFinancialDocument({
      intakeDocumentId: source.id,
      expectedFingerprint: fingerprint,
      kind: "devis",
      contractorId,
      note: "This draft must pass the explicit downstream manual review gate.",
      confirmedByUserId: userId,
    });

    await expect(confirmDevisAndMirror(promoted.id, {
      status: "pending",
      amountHt: "0.001",
      amountTtc: "0.001",
    }, {
      manualReviewConfirmedByUserId: userId,
    })).rejects.toMatchObject<Partial<DevisConfirmGuardError>>({
      code: "manual_intake_review_incomplete",
      status: 422,
    });

    await expect(confirmDevisAndMirror(promoted.id, {
      status: "pending", amountHt: "100.00", amountTtc: "120.00",
    }, { manualReviewConfirmedByUserId: userId })).rejects.toMatchObject({
      code: "source_transcription_reason_required",
    });
    const first = await confirmDevisAndMirror(promoted.id, {
      status: "pending",
      amountHt: "100.00",
      amountTtc: "120.00",
    }, {
      manualReviewConfirmedByUserId: userId,
      sourceTotalsActorId: userId,
      sourceTotalsReason: "Read the missing totals from the original PDF totals box.",
    });
    expect(first.devis).toMatchObject({
      status: "pending",
      manualIntakeReviewRequired: false,
      manualIntakeReviewedByUserId: userId,
    });
    expect(first.devis?.manualIntakeReviewedAt).not.toBeNull();
    const audit = await db.execute(sql`SELECT actor_id,reason,snapshot FROM quotation_source_transcriptions WHERE devis_id=${promoted.id}`);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].actor_id).toBe(userId);
    expect(audit.rows[0].reason).toBe("Read the missing totals from the original PDF totals box.");
    expect((audit.rows[0].snapshot as any).original.amountHt).toBe("0.00");
    expect((audit.rows[0].snapshot as any).transcribed).toEqual({ amountHt: "100.00", amountTtc: "120.00" });
    await expect(db.transaction(async tx => {
      await tx.execute(sql`UPDATE quotation_source_transcriptions SET reason='changed' WHERE devis_id=${promoted.id}`);
    })).rejects.toThrow();

    const second = await confirmDevisAndMirror(promoted.id, {
      status: "pending",
      amountHt: "200.00",
      amountTtc: "240.00",
    }, {
      manualReviewConfirmedByUserId: userId,
    });
    expect(second.devis).toBeUndefined();
    const [stored] = await db.select().from(devis).where(eq(devis.id, promoted.id));
    expect(stored).toMatchObject({
      amountHt: "100.00",
      amountTtc: "120.00",
      manualIntakeReviewedByUserId: userId,
    });
  });

  it("rejects a conflicting auto-persisted invoice and recovers a matching parked invoice only behind manual review", async () => {
    const [otherTarget] = await db.insert(devis).values({
      projectId,
      contractorId,
      devisCode: `MP-CONFLICT-${Date.now()}`,
      descriptionFr: "Other invoice target",
      amountHt: "1000.00",
      amountTtc: "1200.00",
      status: "draft",
    }).returning();
    const source = await createSource({
      analysisState: "analyzed",
      routingState: "parked",
      extractedData: {
        documentType: "invoice",
        invoiceNumber: "AUTO-PARKED-1",
        amountHt: 100,
        amountTtc: 120,
      },
      notes: "Invoice parked after required financial review.",
    });
    const [autoInvoice] = await db.insert(invoices).values({
      devisId: targetDevisId,
      contractorId,
      projectId,
      sourceIntakeDocumentId: source.id,
      invoiceNumber: "AUTO-PARKED-1",
      amountHt: "100.00",
      tvaAmount: "20.00",
      amountTtc: "120.00",
      status: "draft",
      pdfPath: source.storageKey,
      manualIntakeReviewRequired: false,
      validationWarnings: [{ field: "deposit", severity: "error", message: "Financial review pending" }],
      aiExtractedData: source.extractedData,
    }).returning();
    await db.insert(projectDocuments).values({
      projectId,
      fileName: source.fileName,
      storageKey: source.storageKey,
      documentType: "invoice",
      uploadedBy: "intake-auto",
      description: "Automatically persisted before financial review parked the source.",
    });
    const input = {
      intakeDocumentId: source.id,
      expectedFingerprint: fingerprint,
      kind: "invoice" as const,
      note: "Recover the existing automatic invoice only after manual review.",
      confirmedByUserId: userId,
    };

    await expect(promoteParkedFinancialDocument({
      ...input,
      devisId: otherTarget.id,
    })).rejects.toMatchObject<Partial<ManualPromotionError>>({
      status: 409,
      code: "existing_invoice_target_mismatch",
    });
    expect(await db.select().from(intakeManualPromotions)
      .where(eq(intakeManualPromotions.intakeDocumentId, source.id))).toHaveLength(0);
    expect(await db.select().from(projectIntakeDocuments)
      .where(eq(projectIntakeDocuments.id, source.id))).toEqual([
      expect.objectContaining({ routingState: "parked", promotedId: null }),
    ]);

    const recovered = await promoteParkedFinancialDocument({
      ...input,
      devisId: targetDevisId,
    });
    expect(recovered).toMatchObject({
      kind: "invoice",
      id: autoInvoice.id,
      replayed: false,
    });
    const [storedInvoice] = await db.select().from(invoices).where(eq(invoices.id, autoInvoice.id));
    expect(storedInvoice).toMatchObject({
      devisId: targetDevisId,
      projectId,
      contractorId,
      manualIntakeReviewRequired: true,
      manualIntakeReviewedAt: null,
      manualIntakeReviewedByUserId: null,
    });
    expect(storedInvoice.validationWarnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "deposit", message: "Financial review pending" }),
      expect.objectContaining({ field: "manualPromotion", severity: "error" }),
    ]));
    const [audit] = await db.select().from(intakeManualPromotions).where(
      eq(intakeManualPromotions.intakeDocumentId, source.id),
    );
    expect(audit).toMatchObject({
      promotedId: autoInvoice.id,
      targetDevisId,
      contractorId,
    });
    expect(await db.select().from(projectIntakeDocuments)
      .where(eq(projectIntakeDocuments.id, source.id))).toEqual([
      expect.objectContaining({ routingState: "routed", promotedKind: "invoice", promotedId: autoInvoice.id }),
    ]);
    expect((await db.select().from(projectDocuments).where(and(
      eq(projectDocuments.projectId, projectId),
      eq(projectDocuments.storageKey, source.storageKey),
      eq(projectDocuments.documentType, "invoice"),
    )))).toHaveLength(1);
    await db.update(invoices).set({ status: "pending" }).where(eq(invoices.id, autoInvoice.id));
    await expect(approveInvoice(autoInvoice.id)).resolves.toMatchObject({
      success: false,
      status: 409,
      data: { code: "manual_intake_review_required" },
    });
  });

  it("rejects stale bytes, archived projects, and a devis from another project without partial writes", async () => {
    const [otherTarget] = await db.insert(devis).values({
      projectId: otherProjectId,
      contractorId,
      devisCode: `MP-OTHER-${Date.now()}`,
      descriptionFr: "Wrong project target",
      amountHt: "1.00",
      amountTtc: "1.20",
    }).returning();
    const stale = await createSource();
    const archived = await createSource({ projectId: archivedProjectId });
    const wrongProject = await createSource();

    const attempts = await Promise.allSettled([
      promoteParkedFinancialDocument({
        intakeDocumentId: stale.id,
        expectedFingerprint: "0".repeat(64),
        kind: "devis",
        contractorId,
        note: "This stale request must never create a draft.",
        confirmedByUserId: userId,
      }),
      promoteParkedFinancialDocument({
        intakeDocumentId: archived.id,
        expectedFingerprint: fingerprint,
        kind: "devis",
        contractorId,
        note: "Archived projects must remain read-only forever.",
        confirmedByUserId: userId,
      }),
      promoteParkedFinancialDocument({
        intakeDocumentId: wrongProject.id,
        expectedFingerprint: fingerprint,
        kind: "invoice",
        devisId: otherTarget.id,
        note: "Cross-project money assignment must be refused.",
        confirmedByUserId: userId,
      }),
    ]);
    expect(attempts.map((attempt) =>
      attempt.status === "rejected" && attempt.reason instanceof ManualPromotionError
        ? attempt.reason.code
        : "unexpected",
    )).toEqual(["fingerprint_changed", "project_archived", "devis_wrong_project"]);
    expect(await db.select().from(intakeManualPromotions).where(
      sql`${intakeManualPromotions.intakeDocumentId} IN (${stale.id}, ${archived.id}, ${wrongProject.id})`,
    )).toHaveLength(0);
  });
});