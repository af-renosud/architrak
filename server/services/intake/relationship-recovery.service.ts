/**
 * Stored-extraction relationship recovery.  This deliberately never calls an
 * AI parser: it only retries documents explicitly parked by the automatic
 * reference resolver when a later quotation/order supplies new evidence.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { env } from "../../env";
import { db } from "../../db";
import { storage } from "../../storage";
import { getDocumentBuffer } from "../../storage/object-storage";
import { processInvoiceUpload } from "../invoice-upload.service";
import { getConfirmedIntakeProjectIdentity } from "./project-identity-resolution.service";
import { matchToProject, type ParsedDocument } from "../../gmail/document-parser";
import {
  resolveIntakeDocumentRelationship,
  type RelationExtraction,
  type IntakeRelationshipResolution,
} from "@shared/intake-document-relations";
import {
  acompteNoInvoicePayments,
  intakeManualPromotions,
  invoiceAcompteApplications,
  marcheDocuments,
  projectIntakeDocuments,
  projects,
  devis,
} from "@shared/schema";

const MAX_RELATIONSHIP_REEVALUATIONS = 50;
const MAX_SCHEDULED_RELATIONSHIP_PASSES = 2;
const scheduledProjectPasses = new Map<number, { rerun: boolean }>();

export interface IntakeRelationshipPreviewItem {
  id: number;
  fileName: string;
  canResolve: boolean;
  explanation: string;
}

export interface IntakeRelationshipPreview {
  items: IntakeRelationshipPreviewItem[];
  token: string;
}

export class IntakeRelationshipRecoveryError extends Error {
  constructor(
    readonly code: "preview_token_invalid" | "stale_source" | "relationship_conflict",
    message: string,
  ) {
    super(message);
    this.name = "IntakeRelationshipRecoveryError";
  }
  readonly status = 409;
}

interface PreviewClaim {
  id: number;
  fingerprint: string;
  canResolve: boolean;
  explanation: string;
  /** Binds the dry run to the selected target, not merely its display text. */
  resolutionKey: string;
}

interface PreviewTokenPayload {
  projectId: number;
  claims: PreviewClaim[];
}

function isAutomaticallyRelationshipParked(doc: {
  analysisState: string;
  routingState: string;
  promotedId: number | null;
  contentFingerprint: string | null;
  extractedData: unknown;
  notes: string | null;
}): boolean {
  const marker = (doc.extractedData as {
    relationshipResolution?: { automaticParked?: unknown; sourceFingerprint?: unknown };
  } | null)?.relationshipResolution;
  const parsedType = (doc.extractedData as { documentType?: unknown } | null)?.documentType;
  // Legacy automatic-router rows predate relationshipResolution. Their
  // generated cardinality note is narrow enough to distinguish them from
  // operator decisions; immutable/manual evidence is excluded separately.
  const legacyGeneratedPark = (
    parsedType === "invoice" || parsedType === "acompte" || parsedType === "commande"
  ) && (doc.notes ?? "").split("\n").some((line) =>
    /^(?:Invoice|Bon de commande) parked: (?:no|\d+) devis match for this contractor — attach manually\.$/.test(line.trim()),
  );
  return doc.analysisState === "analyzed"
    && doc.routingState === "parked"
    && doc.promotedId == null
    && typeof doc.contentFingerprint === "string"
    && (
      (marker?.automaticParked === true && marker.sourceFingerprint === doc.contentFingerprint)
      || legacyGeneratedPark
    );
}

function encodeToken(payload: PreviewTokenPayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", env.SESSION_SECRET).update(body).digest("base64url");
  return `${body}.${signature}`;
}

function decodeToken(token: string): PreviewTokenPayload | null {
  const [body, signature, ...extra] = token.split(".");
  if (!body || !signature || extra.length) return null;
  const expected = createHmac("sha256", env.SESSION_SECRET).update(body).digest("base64url");
  const given = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (given.length !== expectedBuffer.length || !timingSafeEqual(given, expectedBuffer)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as PreviewTokenPayload;
    if (!Number.isInteger(parsed.projectId) || !Array.isArray(parsed.claims) || parsed.claims.length > MAX_RELATIONSHIP_REEVALUATIONS) {
      return null;
    }
    if (!parsed.claims.every((claim) =>
      Number.isInteger(claim.id)
      && typeof claim.fingerprint === "string"
      && typeof claim.canResolve === "boolean"
      && typeof claim.explanation === "string"
      && typeof claim.resolutionKey === "string",
    )) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function relationshipForStoredDocument(
  doc: { id: number; projectId: number; contentFingerprint: string | null; extractedData: unknown },
  context?: {
    allProjects: Awaited<ReturnType<typeof storage.getProjects>>;
    allContractors: Awaited<ReturnType<typeof storage.getContractors>>;
    allDevis: Awaited<ReturnType<typeof storage.getDevisByProject>>;
    orders: Awaited<ReturnType<typeof storage.getMarcheDocumentsByProject>>;
  },
): Promise<IntakeRelationshipResolution> {
  const parsed = (doc.extractedData ?? {}) as ParsedDocument;
  const [allProjects, allContractors, allDevis, orders] = context
    ? [context.allProjects, context.allContractors, context.allDevis, context.orders]
    : await Promise.all([
        storage.getProjects({ includeArchived: true }),
        storage.getContractors(),
        storage.getDevisByProject(doc.projectId),
        storage.getMarcheDocumentsByProject(doc.projectId),
      ]);
  const match = await matchToProject(parsed, allProjects, allContractors);
  const confirmed = doc.contentFingerprint
    ? await getConfirmedIntakeProjectIdentity(doc.id, doc.contentFingerprint)
    : null;
  if (
    (parsed.projectName || parsed.projectReference)
    && match.projectId !== doc.projectId
    && confirmed?.projectId !== doc.projectId
  ) {
    return {
      outcome: "parked",
      code: "contractor_unresolved",
      explanation: "Parked: labelled project identity is unresolved or belongs to another project.",
      references: [],
    };
  }
  return resolveIntakeDocumentRelationship({
    parsed: parsed as RelationExtraction,
    contractorId: match.contractorId,
    allDevis,
    orders,
  });
}

async function buildPreview(projectId: number): Promise<{
  items: IntakeRelationshipPreviewItem[];
  claims: PreviewClaim[];
  totalEligible: number;
}> {
  const project = await storage.getProject(projectId);
  const docs = await storage.getProjectIntakeDocuments(projectId, { includeVoid: true });
  const candidates = docs.filter(isAutomaticallyRelationshipParked);
  // Do not reinterpret a historical generated note if a human later used the
  // source in a manual-promotion or payment-evidence workflow. These records
  // are immutable even though their old intake row may look parked.
  const candidateIds = candidates.map((doc) => doc.id);
  const immutableSourceIds = new Set<number>();
  if (candidateIds.length) {
    const [manual, payments, applications] = await Promise.all([
      db.select({ id: intakeManualPromotions.intakeDocumentId }).from(intakeManualPromotions)
        .where(inArray(intakeManualPromotions.intakeDocumentId, candidateIds)),
      db.select({ id: acompteNoInvoicePayments.sourceIntakeDocumentId }).from(acompteNoInvoicePayments)
        .where(inArray(acompteNoInvoicePayments.sourceIntakeDocumentId, candidateIds)),
      db.select({ id: invoiceAcompteApplications.sourceIntakeDocumentId }).from(invoiceAcompteApplications)
        .where(inArray(invoiceAcompteApplications.sourceIntakeDocumentId, candidateIds)),
    ]);
    for (const row of [...manual, ...payments, ...applications]) immutableSourceIds.add(row.id);
  }
  const eligible = candidates.filter((doc) => !immutableSourceIds.has(doc.id)).sort((a, b) => a.id - b.id);
  if (!project || project.archivedAt != null) {
    const explanation = !project ? "Project not found." : "Archived projects are read-only.";
    const bounded = eligible.slice(0, MAX_RELATIONSHIP_REEVALUATIONS);
    return {
      items: bounded.map((doc) => ({ id: doc.id, fileName: doc.fileName, canResolve: false, explanation })),
      claims: bounded.map((doc) => ({
        id: doc.id,
        fingerprint: doc.contentFingerprint!,
        canResolve: false,
        explanation,
        resolutionKey: "project-unavailable",
      })),
      totalEligible: eligible.length,
    };
  }
  const [allProjects, allContractors, allDevis, orders] = await Promise.all([
    storage.getProjects({ includeArchived: true }),
    storage.getContractors(),
    storage.getDevisByProject(projectId),
    storage.getMarcheDocumentsByProject(projectId),
  ]);
  // Evaluate the complete eligible population against this one shared
  // relationship snapshot before imposing the write/preview cap. Otherwise
  // old unresolved rows at the head of ID order permanently starve a newer
  // row whose reference has become resolvable.
  const evaluated = await Promise.all(eligible.map(async (doc) => {
    const resolution = await relationshipForStoredDocument(doc, { allProjects, allContractors, allDevis, orders });
    return {
      id: doc.id,
      fileName: doc.fileName,
      fingerprint: doc.contentFingerprint!,
      canResolve: resolution.outcome === "resolved",
      explanation: resolution.explanation,
      resolutionKey: resolution.outcome === "resolved"
        ? `resolved:${resolution.devisId}:${resolution.route}`
        : `parked:${resolution.code}`,
    };
  }));
  const prioritized = evaluated
    .sort((a, b) => Number(b.canResolve) - Number(a.canResolve) || a.id - b.id)
    .slice(0, MAX_RELATIONSHIP_REEVALUATIONS);
  return {
    items: prioritized.map(({ fingerprint: _fingerprint, resolutionKey: _resolutionKey, ...item }) => item),
    claims: prioritized.map(({ id, fingerprint, canResolve, explanation, resolutionKey }) => ({
      id, fingerprint, canResolve, explanation, resolutionKey,
    })),
    totalEligible: eligible.length,
  };
}

/** Read-only dry run used by the intake routes. */
export async function previewProjectIntakeRelationships(projectId: number): Promise<IntakeRelationshipPreview> {
  const preview = await buildPreview(projectId);
  return {
    items: preview.items,
    token: encodeToken({ projectId, claims: preview.claims }),
  };
}

async function markRelationshipResult(
  docId: number,
  fingerprint: string,
  parsed: ParsedDocument,
  routingState: "parked" | "routed",
  explanation: string,
  actor: string,
  promoted?: { kind: "invoice"; id: number },
): Promise<boolean> {
  const [updated] = await db.update(projectIntakeDocuments).set({
    analysisState: "analyzed",
    routingState,
    ...(promoted ? { promotedKind: promoted.kind, promotedId: promoted.id } : {}),
    extractedData: {
      ...parsed,
      relationshipResolution: {
        automaticParked: routingState === "parked",
        sourceFingerprint: fingerprint,
        explanation,
        actor,
      },
    },
  }).where(and(
    eq(projectIntakeDocuments.id, docId),
    eq(projectIntakeDocuments.contentFingerprint, fingerprint),
    eq(projectIntakeDocuments.analysisState, "analyzed"),
    eq(projectIntakeDocuments.routingState, "parked"),
    isNull(projectIntakeDocuments.promotedId),
  )).returning({ id: projectIntakeDocuments.id });
  return Boolean(updated);
}

/**
 * Applies a preview only if its exact source fingerprints and current
 * resolution remain unchanged.  Each source and target/project are locked
 * while re-resolving so a stale preview cannot attach an invoice to a target
 * which was changed, voided, or joined by a conflicting reference.
 */
export async function applyProjectIntakeRelationships(
  projectId: number,
  token: string,
  actor: string | number,
  remainingBudget: number = MAX_RELATIONSHIP_REEVALUATIONS,
): Promise<{ processed: number; matched: number; remaining: number; failures?: Array<{ id: number; fileName: string; message: string }> }> {
  const payload = decodeToken(token);
  if (!payload || payload.projectId !== projectId) {
    throw new IntakeRelationshipRecoveryError(
      "preview_token_invalid",
      "Relationship preview is invalid, stale, or belongs to another project. Refresh the preview.",
    );
  }
  let processed = 0;
  let matched = 0;
  const failures: Array<{ id: number; fileName: string; message: string }> = [];
  const actorText = String(actor);
  for (const claim of payload.claims) {
    if (processed >= remainingBudget) break;
    if (!claim.canResolve) continue;
    const prepared = await db.transaction(async (tx) => {
      const [project] = await tx.select().from(projects).where(eq(projects.id, projectId)).for("update");
      if (!project || project.archivedAt != null) return null;
      const [doc] = await tx.select().from(projectIntakeDocuments)
        .where(eq(projectIntakeDocuments.id, claim.id)).for("update");
      if (!doc || doc.projectId !== projectId || doc.contentFingerprint !== claim.fingerprint || !isAutomaticallyRelationshipParked(doc)) {
        return null;
      }
      // Lock all possible targets and orders before taking the current
      // snapshot. This is the revalidation boundary for candidate races.
      const lockedDevis = await tx.select().from(devis).where(eq(devis.projectId, projectId)).for("update");
      const lockedOrders = await tx.select().from(marcheDocuments).where(eq(marcheDocuments.projectId, projectId)).for("update");
      const [allProjects, allContractors] = await Promise.all([
        storage.getProjects({ includeArchived: true }),
        storage.getContractors(),
      ]);
      const resolution = await relationshipForStoredDocument(doc, {
        allProjects,
        allContractors,
        allDevis: lockedDevis,
        orders: lockedOrders,
      });
      if (
        resolution.outcome !== "resolved"
        || resolution.explanation !== claim.explanation
        || `resolved:${resolution.devisId}:${resolution.route}` !== claim.resolutionKey
      ) return null;
      const target = lockedDevis.find((candidate) => candidate.id === resolution.devisId);
      if (!target) return null;
      const parsed = (doc.extractedData ?? {}) as ParsedDocument;
      return { doc, parsed, resolution, contractorId: target.contractorId, target };
    });
    if (!prepared) {
      throw new IntakeRelationshipRecoveryError(
        "stale_source",
        "A source document or its matching evidence changed. Refresh the preview before applying.",
      );
    }
    processed++;
    const { doc, parsed, resolution, contractorId, target } = prepared;
    try {
      if (parsed.documentType === "commande") {
        const target = await storage.getDevis(resolution.devisId);
        if (!target || target.projectId !== projectId) throw new Error("Resolved devis changed before evidence routing.");
        const result = await storage.createMarcheDocumentAndRouteIntake({
          data: {
            projectId,
            kind: "commande",
            storageKey: doc.storageKey,
            fileName: doc.fileName,
            devisId: target.id,
            marcheId: target.marcheId ?? null,
            sourceIntakeDocumentId: doc.id,
            extractedData: doc.extractedData as Record<string, unknown>,
            uploadedBy: `relationship-auto:${actorText}`,
          },
          intakeNote: `Automatically linked by explicit reference chain: ${resolution.explanation}`,
          existingIntakeNotes: doc.notes,
          expectedRoutingState: "parked",
          contentFingerprint: claim.fingerprint,
          relationshipGuard: {
            contractorId,
            expectedDevisId: resolution.devisId,
            expectedResolutionKey: `resolved:${resolution.devisId}:${resolution.route}`,
            expectedAnalysisState: "analyzed",
          },
        });
        if (!("conflict" in result)) {
          matched++;
          continue;
        }
        throw new Error(result.conflict);
      }
      if (parsed.documentType === "situation") {
        const number = typeof parsed.situationNumber === "number" && Number.isInteger(parsed.situationNumber)
          ? parsed.situationNumber : null;
        if (number == null) throw new Error("Situation number is required for stored relationship recovery.");
        const existing = (await storage.getSituationsByDevis(resolution.devisId))
          .find((situation) => situation.situationNumber === number);
        if (!existing) {
          const { createDraftSituationFromParsed } = await import("../situation-review.service");
          await createDraftSituationFromParsed({
            devis: target,
            parsed,
            fileName: doc.fileName,
            storageKey: doc.storageKey,
            atomicRoute: {
              intakeDocumentId: doc.id,
              contentFingerprint: claim.fingerprint,
              expectedRoutingState: "parked",
              expectedAnalysisState: "analyzed",
              contractorId,
              resolutionKey: `resolved:${resolution.devisId}:${resolution.route}`,
              intakeNote: `Automatically linked situation by explicit reference chain: ${resolution.explanation}`,
            },
          });
          matched++;
          continue;
        }
        const result = await storage.attachSituationSourceAndRouteIntake({
          situationId: existing.id,
          intakeDocumentId: doc.id,
          sourceStorageKey: doc.storageKey,
          sourceFileName: doc.fileName,
          sourceUploadedBy: `relationship-auto:${actorText}`,
          confirmed: false,
          intakeNote: `Automatically linked situation by explicit reference chain: ${resolution.explanation}`,
          existingIntakeNotes: doc.notes,
          expectedRoutingState: "parked",
          contentFingerprint: claim.fingerprint,
          relationshipGuard: {
            contractorId,
            expectedDevisId: resolution.devisId,
            expectedResolutionKey: `resolved:${resolution.devisId}:${resolution.route}`,
            expectedAnalysisState: "analyzed",
          },
        });
        if ("conflict" in result) throw new Error(result.conflict);
        matched++;
        continue;
      }
      if (parsed.documentType !== "invoice" && parsed.documentType !== "acompte") {
        throw new Error("Only invoices, deposits, and orders can be relationship-re-evaluated.");
      }
      const buffer = await getDocumentBuffer(doc.storageKey);
      const result = await processInvoiceUpload(resolution.devisId, {
        originalname: doc.fileName,
        buffer,
        mimetype: doc.mimeType ?? "application/pdf",
      }, parsed, {
        sourceIntakeDocumentId: doc.id,
        relationshipGuard: {
          sourceContentFingerprint: claim.fingerprint,
          sourceAnalysisState: "analyzed",
          sourceRoutingState: "parked",
          contractorId,
          expectedDevisId: resolution.devisId,
          expectedResolutionKey: `resolved:${resolution.devisId}:${resolution.route}`,
          intakeNote: `Automatically linked by explicit reference chain (${actorText}): ${resolution.explanation}`,
        },
      });
      if (!result.success) {
        const committed = await storage.getProjectIntakeDocument(doc.id);
        if (committed?.promotedKind === "invoice" && committed.promotedId != null) {
          matched++;
          continue;
        }
        throw new Error((result.data as { message?: string }).message ?? "Invoice routing failed.");
      }
      matched++;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ id: doc.id, fileName: doc.fileName, message });
      await markRelationshipResult(
        doc.id,
        claim.fingerprint,
        parsed,
        "parked",
        `Parked after stored relationship re-evaluation: ${message}`,
        actorText,
      );
    }
  }
  const after = await buildPreview(projectId);
  // A commande resolved in this pass can unlock an invoice which arrived
  // first. Re-preview once through the same signed/fingerprint-bound path so
  // that normal recovery handles the complete order -> invoice chain without
  // asking an operator to click twice. Recursion stops when no promotion was
  // made (for example a financial gate parked the invoice).
  if (matched > 0 && processed < remainingBudget && after.items.some((item) => item.canResolve)) {
    const nextBudget = remainingBudget - processed;
    const chained = await applyProjectIntakeRelationships(
      projectId,
      encodeToken({ projectId, claims: after.claims.slice(0, nextBudget) }),
      actor,
      nextBudget,
    );
    return {
      processed: processed + chained.processed,
      matched: matched + chained.matched,
      remaining: chained.remaining,
      failures: [...failures, ...(chained.failures ?? [])],
    };
  }
  return { processed, matched, remaining: after.totalEligible, ...(failures.length ? { failures } : {}) };
}

/** Internal bounded automatic pass, deliberately with no parser/provider AI. */
export async function reEvaluateStoredIntakeRelationships(
  projectId: number,
  actor: string = "intake-auto",
): Promise<{ processed: number; matched: number; remaining: number }> {
  const preview = await previewProjectIntakeRelationships(projectId);
  return applyProjectIntakeRelationships(projectId, preview.token, actor);
}

/** Coalesced final pass for a document that just parked while evidence races in. */
export function scheduleStoredIntakeRelationshipReevaluation(projectId: number): void {
  const existing = scheduledProjectPasses.get(projectId);
  if (existing) {
    // A second document parked while the first pass was reading its snapshot;
    // one final pass after the active one closes that narrow arrival race.
    existing.rerun = true;
    return;
  }
  const state = { rerun: false };
  scheduledProjectPasses.set(projectId, state);
  queueMicrotask(() => {
    (async () => {
      let passes = 0;
      do {
        state.rerun = false;
        await reEvaluateStoredIntakeRelationships(projectId, "intake-auto");
        passes++;
      } while (state.rerun && passes < MAX_SCHEDULED_RELATIONSHIP_PASSES);
    })()
      .catch((error) => console.warn(`[intake-relationship] scheduled re-evaluation failed for project ${projectId}:`, error))
      .finally(() => scheduledProjectPasses.delete(projectId));
  });
}