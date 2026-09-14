import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import {
  contractors,
  devis,
  devisLineItems,
  invoices,
  marcheDocuments,
  projectDocuments,
  projectIntakeDocuments,
  projects,
  situationLines,
  situations,
} from "@shared/schema";

// Recovery must not need the original intake bytes to be parsed again. The
// invoice uploader still receives a PDF buffer and writes its normal draft
// artefact, so object storage is mocked rather than calling a provider.
vi.mock("../storage/object-storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../storage/object-storage")>();
  return {
    ...actual,
    getDocumentBuffer: vi.fn(async () => Buffer.from("%PDF-1.4\n%%EOF")),
    uploadDocument: vi.fn(async (_projectId: number, name: string) => `tests/recovery/${name}`),
  };
});

import {
  applyProjectIntakeRelationships,
  previewProjectIntakeRelationships,
} from "../services/intake/relationship-recovery.service";
import { storage } from "../storage";

let projectId = 0;
let contractorId = 0;
let devisId = 0;
let orderId = 0;
const fingerprint = "e".repeat(64);
const sourceIds: number[] = [];

async function intakeInvoice(number: string, type: "invoice" | "acompte" = "invoice") {
  const [row] = await db.insert(projectIntakeDocuments).values({
    projectId,
    fileName: `${number}.pdf`,
    storageKey: `tests/recovery/source-${number}.pdf`,
    contentFingerprint: fingerprint,
    analysisState: "analyzed",
    routingState: "parked",
    // Legacy-shaped extraction deliberately has no new typed-reference array.
    extractedData: {
      documentType: type,
      invoiceNumber: number,
      contractorName: "Recovery contractor",
      amountHt: 100,
      amountTtc: 120,
      lineItems: [{ description: "Acompte sur la commande n° CM-REC-195", pageHint: 1 }],
    },
    notes: "Invoice parked: 2 devis match for this contractor — attach manually.",
  }).returning();
  sourceIds.push(row.id);
  return row;
}

beforeAll(async () => {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const [project] = await db.insert(projects).values({
    code: `T-REL-${suffix}`.slice(0, 50),
    name: `Relationship recovery ${suffix}`,
    clientName: "Test",
  }).returning();
  projectId = project.id;
  const [contractor] = await db.insert(contractors).values({ name: "Recovery contractor" }).returning();
  contractorId = contractor.id;
  const created = await db.insert(devis).values([
    {
      projectId, contractorId, devisCode: `REC.1.MENU.${suffix}`, devisNumber: "DE-REC-392",
      descriptionFr: "Target", amountHt: "1000", amountTtc: "1200", status: "accepted",
    },
    {
      projectId, contractorId, devisCode: `REC.2.UNRELATED.${suffix}`, devisNumber: "DE-REC-400",
      descriptionFr: "Unrelated", amountHt: "1000", amountTtc: "1200", status: "accepted",
    },
  ]).returning();
  devisId = created[0].id;
});

afterAll(async () => {
  if (!projectId) return;
  await db.delete(invoices).where(eq(invoices.projectId, projectId));
  await db.delete(projectDocuments).where(eq(projectDocuments.projectId, projectId));
  await db.delete(marcheDocuments).where(eq(marcheDocuments.projectId, projectId));
  await db.delete(projectIntakeDocuments).where(eq(projectIntakeDocuments.projectId, projectId));
  await db.delete(devis).where(eq(devis.projectId, projectId));
  await db.delete(projects).where(eq(projects.id, projectId));
  await db.delete(contractors).where(eq(contractors.id, contractorId));
});

describe("stored intake relationship recovery", () => {
  it("keeps the existing reviewed commande attach contract for an analyzed parked source", async () => {
    const [source] = await db.insert(projectIntakeDocuments).values({
      projectId,
      fileName: "manual-commande.pdf",
      storageKey: "tests/recovery/manual-commande.pdf",
      contentFingerprint: "m".repeat(64),
      analysisState: "analyzed",
      routingState: "parked",
      extractedData: { documentType: "commande" },
      notes: "Awaiting reviewed manual attachment.",
    }).returning();
    try {
      const result = await storage.createMarcheDocumentAndRouteIntake({
        data: {
          projectId,
          kind: "commande",
          storageKey: source.storageKey,
          fileName: source.fileName,
          devisId,
          sourceIntakeDocumentId: source.id,
          extractedData: { documentType: "commande" },
          uploadedBy: "test",
        },
        intakeNote: "Manually attached.",
        existingIntakeNotes: source.notes,
        expectedRoutingState: "parked",
        contentFingerprint: source.contentFingerprint!,
      });
      expect("conflict" in result).toBe(false);
      const routed = await db.select().from(projectIntakeDocuments).where(eq(projectIntakeDocuments.id, source.id));
      expect(routed[0]).toMatchObject({ routingState: "routed", promotedKind: "marche_document" });
    } finally {
      await db.delete(marcheDocuments).where(eq(marcheDocuments.sourceIntakeDocumentId, source.id));
      await db.delete(projectIntakeDocuments).where(eq(projectIntakeDocuments.id, source.id));
    }
  });

  it("recovers invoice-first legacy evidence after an order arrives, retaining a full invoice series", async () => {
    await intakeInvoice("FD-REC-125", "acompte");
    let preview = await previewProjectIntakeRelationships(projectId);
    expect(preview.items).toHaveLength(1);
    expect(preview.items[0]).toMatchObject({ canResolve: false });
    expect(await applyProjectIntakeRelationships(projectId, preview.token, "test-operator"))
      .toMatchObject({ processed: 0, matched: 0, remaining: 1 });

    const [order] = await db.insert(marcheDocuments).values({
      projectId,
      kind: "commande",
      storageKey: "tests/recovery/order.pdf",
      fileName: "CM-REC-195.pdf",
      devisId,
      extractedData: { documentType: "commande", reference: "CM-REC-195", devisNumber: "DE-REC-392" },
      status: "draft",
      uploadedBy: "test",
    }).returning();
    orderId = order.id;
    await Promise.all([
      intakeInvoice("FA-REC-PROGRESS-1"),
      intakeInvoice("FA-REC-PROGRESS-2"),
      intakeInvoice("FA-REC-FINAL"),
    ]);
    preview = await previewProjectIntakeRelationships(projectId);
    expect(preview.items).toHaveLength(4);
    expect(preview.items.every((item) => item.canResolve)).toBe(true);

    const result = await applyProjectIntakeRelationships(projectId, preview.token, "test-operator");
    expect(result).toMatchObject({ processed: 4, matched: 4, remaining: 0 });
    const routed = await db.select().from(invoices).where(eq(invoices.projectId, projectId));
    expect(routed).toHaveLength(4);
    expect(routed.every((invoice) => invoice.devisId === devisId)).toBe(true);
    expect(new Set(routed.map((invoice) => invoice.invoiceNumber)).size).toBe(4);
    const sources = await db.select().from(projectIntakeDocuments).where(
      and(eq(projectIntakeDocuments.projectId, projectId), eq(projectIntakeDocuments.routingState, "routed")),
    );
    expect(sources).toHaveLength(4);
    // Idempotent replay after the invoice-before-order chain is fully routed
    // cannot create a second financial record or revive parked intake work.
    const replay = await previewProjectIntakeRelationships(projectId);
    expect(await applyProjectIntakeRelationships(projectId, replay.token, "test-operator"))
      .toMatchObject({ processed: 0, matched: 0, remaining: 0 });
    expect(await db.select().from(invoices).where(eq(invoices.projectId, projectId))).toHaveLength(4);
  });

  it("prioritizes a resolvable source after 51 unresolved automatic parks", async () => {
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
    const rows = Array.from({ length: 51 }, (_, index) => ({
      projectId,
      fileName: `unresolved-${suffix}-${index}.pdf`,
      storageKey: `tests/recovery/unresolved-${suffix}-${index}.pdf`,
      contentFingerprint: `${index.toString(16).padStart(2, "0")}${"a".repeat(62)}`,
      analysisState: "analyzed" as const,
      routingState: "parked" as const,
      extractedData: {
        documentType: "invoice",
        contractorName: "Recovery contractor",
        relationshipResolution: {
          automaticParked: true,
          sourceFingerprint: `${index.toString(16).padStart(2, "0")}${"a".repeat(62)}`,
        },
      },
      notes: "Invoice parked by automatic relationship resolver.",
    }));
    const unresolved = await db.insert(projectIntakeDocuments).values(rows).returning();
    let resolvableId = 0;
    try {
      const resolvableFingerprint = `ff${"b".repeat(62)}`;
      const [resolvable] = await db.insert(projectIntakeDocuments).values({
        projectId,
        fileName: `resolvable-${suffix}.pdf`,
        storageKey: `tests/recovery/resolvable-${suffix}.pdf`,
        contentFingerprint: resolvableFingerprint,
        analysisState: "analyzed",
        routingState: "parked",
        extractedData: {
          documentType: "commande",
          contractorName: "Recovery contractor",
          relatedDocumentReferences: [{
            kind: "quotation",
            reference: "DE-REC-392",
            evidenceText: "Devis n° DE-REC-392",
          }],
          relationshipResolution: {
            automaticParked: true,
            sourceFingerprint: resolvableFingerprint,
          },
        },
        notes: "Commande parked by automatic relationship resolver.",
      }).returning();
      resolvableId = resolvable.id;

      const preview = await previewProjectIntakeRelationships(projectId);
      expect(preview.items).toHaveLength(50);
      expect(preview.items[0]).toMatchObject({ id: resolvable.id, canResolve: true });

      const applied = await applyProjectIntakeRelationships(projectId, preview.token, "test-operator");
      expect(applied).toMatchObject({ processed: 1, matched: 1, remaining: 51 });
      const [routed] = await db.select().from(projectIntakeDocuments)
        .where(eq(projectIntakeDocuments.id, resolvable.id));
      expect(routed).toMatchObject({ routingState: "routed", promotedKind: "marche_document" });
    } finally {
      if (resolvableId) {
        await db.delete(marcheDocuments).where(eq(marcheDocuments.sourceIntakeDocumentId, resolvableId));
        await db.delete(projectIntakeDocuments).where(eq(projectIntakeDocuments.id, resolvableId));
      }
      await db.delete(projectIntakeDocuments).where(inArray(
        projectIntakeDocuments.id,
        unresolved.map((row) => row.id),
      ));
    }
  });

  it("creates a new mode_b situation from explicit order evidence atomically and replays idempotently", async () => {
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
    const [contractor] = await db.insert(contractors).values({
      name: `Situation recovery contractor ${suffix}`,
    }).returning();
    const [quotation] = await db.insert(devis).values({
      projectId,
      contractorId: contractor.id,
      devisCode: `REC-SIT-${suffix}`,
      devisNumber: `DE-SIT-${suffix}`,
      descriptionFr: "Situation target",
      amountHt: "1000.00",
      amountTtc: "1200.00",
      invoicingMode: "mode_b",
      status: "accepted",
    }).returning();
    const [line] = await db.insert(devisLineItems).values({
      devisId: quotation.id,
      lineNumber: 1,
      description: "Pose menuiserie",
      quantity: "1",
      unitPriceHt: "1000.00",
      totalHt: "1000.00",
    }).returning();
    const orderReference = `CM-SIT-${suffix}`;
    const [order] = await db.insert(marcheDocuments).values({
      projectId,
      kind: "commande",
      storageKey: `tests/recovery/${orderReference}.pdf`,
      fileName: `${orderReference}.pdf`,
      devisId: quotation.id,
      extractedData: { documentType: "commande", reference: orderReference, devisNumber: quotation.devisNumber },
      status: "draft",
      uploadedBy: "test",
    }).returning();
    let sourceId = 0;
    try {
      const [source] = await db.insert(projectIntakeDocuments).values({
        projectId,
        fileName: `SIT-${suffix}.pdf`,
        storageKey: `tests/recovery/SIT-${suffix}.pdf`,
        contentFingerprint: "f".repeat(64),
        analysisState: "analyzed",
        routingState: "parked",
        extractedData: {
          documentType: "situation",
          situationNumber: 1,
          contractorName: contractor.name,
          relatedDocumentReferences: [{
            kind: "order",
            reference: orderReference,
            evidenceText: `Bon de commande n° ${orderReference}`,
          }],
          lineItems: [{ description: "Pose menuiserie", percentComplete: 25 }],
          relationshipResolution: { automaticParked: true, sourceFingerprint: "f".repeat(64) },
        },
        notes: "Situation parked by automatic relationship resolver.",
      }).returning();
      sourceId = source.id;
      const preview = await previewProjectIntakeRelationships(projectId);
      expect(preview.items.find((item) => item.id === source.id)).toMatchObject({ canResolve: true });
      const applied = await applyProjectIntakeRelationships(projectId, preview.token, "test-operator");
      expect(applied.matched).toBeGreaterThanOrEqual(1);
      const [created] = await db.select().from(situations).where(eq(situations.devisId, quotation.id));
      expect(created).toMatchObject({
        situationNumber: 1,
        status: "draft",
        sourceIntakeDocumentId: source.id,
        sourceStorageKey: source.storageKey,
      });
      const createdLines = await db.select().from(situationLines).where(eq(situationLines.situationId, created.id));
      expect(createdLines).toHaveLength(1);
      expect(createdLines[0]).toMatchObject({ devisLineItemId: line.id, percentComplete: "25.00" });
      // The guarded insert receives a baseline fingerprint from the review
      // calculation. A confirmed baseline changed before commit must reject,
      // rather than applying stale previous/cumulative amounts.
      await db.update(situations).set({ status: "confirmed" }).where(eq(situations.id, created.id));
      const [staleSource] = await db.insert(projectIntakeDocuments).values({
        projectId, fileName: `SIT-stale-${suffix}.pdf`, storageKey: `tests/recovery/SIT-stale-${suffix}.pdf`,
        contentFingerprint: "g".repeat(64), analysisState: "analyzed", routingState: "parked",
        extractedData: {
          documentType: "situation", contractorName: contractor.name,
          relatedDocumentReferences: [{ kind: "order", reference: orderReference, evidenceText: `Commande ${orderReference}` }],
          relationshipResolution: { automaticParked: true, sourceFingerprint: "g".repeat(64) },
        },
        notes: "Situation parked by automatic relationship resolver.",
      }).returning();
      const stale = await storage.createGuardedDraftSituationAndRouteIntake({
        situation: {
          devisId: quotation.id, dateIssued: null, cumulativeHt: "500.00", previousHt: "250.00",
          netHt: "250.00", retenueGarantie: "0.00", netToPayHt: "250.00", tvaAmount: "50.00",
          netToPayTtc: "300.00", status: "draft", aiExtractedData: {},
        },
        lines: [{
          devisLineItemId: line.id, percentComplete: "50.00", cumulativeAmount: "500.00",
          previousAmount: "250.00", netAmount: "250.00", claimedPercent: "50.00",
          checkStatus: "unchecked", checkNotes: null,
        }],
        intakeDocumentId: staleSource.id, sourceStorageKey: staleSource.storageKey,
        sourceFileName: staleSource.fileName, sourceUploadedBy: "test", intakeNote: "test",
        contentFingerprint: staleSource.contentFingerprint!, expectedRoutingState: "parked",
        expectedAnalysisState: "analyzed", baselineSituationId: created.id,
        baselineFingerprint: "intentionally-stale",
        relationshipGuard: {
          contractorId: contractor.id, expectedDevisId: quotation.id,
          expectedResolutionKey: `resolved:${quotation.id}:order`,
        },
      });
      expect(stale).toMatchObject({ conflict: expect.stringMatching(/baseline changed/) });
      await db.delete(projectIntakeDocuments).where(eq(projectIntakeDocuments.id, staleSource.id));
      const replay = await previewProjectIntakeRelationships(projectId);
      await applyProjectIntakeRelationships(projectId, replay.token, "test-operator");
      expect(await db.select().from(situations).where(eq(situations.devisId, quotation.id))).toHaveLength(1);
    } finally {
      await db.delete(situationLines).where(sql`${situationLines.situationId} IN (SELECT ${situations.id} FROM ${situations} WHERE ${situations.devisId} = ${quotation.id})`);
      await db.delete(situations).where(eq(situations.devisId, quotation.id));
      if (sourceId) await db.delete(projectIntakeDocuments).where(eq(projectIntakeDocuments.id, sourceId));
      await db.delete(marcheDocuments).where(eq(marcheDocuments.id, order.id));
      await db.delete(devisLineItems).where(eq(devisLineItems.devisId, quotation.id));
      await db.delete(devis).where(eq(devis.id, quotation.id));
      await db.delete(contractors).where(eq(contractors.id, contractor.id));
    }
  });
});