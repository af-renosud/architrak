/**
 * Task #650 — Planning Envelope Service
 *
 * Focused service that talks directly to the DB. Kept separate from IStorage
 * to avoid bloating the storage interface with internal-only planning state.
 * All functions are individually importable for unit testing.
 */
import crypto from "node:crypto";
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { db } from "../db";
import {
  planningEnvelopes,
  planningRevisions,
  planningRevisionLines,
  planningRevisionSources,
  planningRevisionEvents,
  planningImportJobs,
  devis,
  devisLineItems,
  contractors,
  lots,
  archidocTechnicalLots,
  projects,
  type PlanningEnvelope,
  type PlanningRevision,
  type PlanningRevisionLine,
  type PlanningRevisionSource,
  type PlanningImportJob,
  type PlanningImportStage,
  type PlanningImportStatus,
} from "@shared/schema";
import { roundCurrency } from "../../shared/financial-utils";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const LOW_CONFIDENCE_THRESHOLD = 80;
const PLANNING_IMPORT_STALE_AFTER_MS = 5 * 60 * 1000;

// ─────────────────────────────────────────────────────────────────────────────
// Error class
// ─────────────────────────────────────────────────────────────────────────────

export type PlanningEnvelopeErrorCode =
  | "ENVELOPE_NOT_FOUND"
  | "REVISION_NOT_FOUND"
  | "REVISION_WRONG_PROJECT"
  | "REVISION_STATUS_CONFLICT"
  | "REVISION_CAS_CONFLICT"
  | "REVISION_APPROVED_IMMUTABLE"
  | "REVISION_VALIDATION_FAILED"
  | "REVISION_SOURCE_VERIFICATION_REQUIRED"
  | "REVISION_SNAPSHOT_HASH_MISMATCH"
  | "REVISION_SNAPSHOT_IDENTITY_MISMATCH"
  | "REVISION_ALREADY_PROMOTED"
  | "REVISION_NOT_APPROVED"
  | "REVISION_CROSS_PROJECT_LOT"
  | "REVISION_SUPERSEDES_MISMATCH"
  | "REVISION_EMPTY_PATCH"
  | "REVISION_DELETE_NOT_ALLOWED"
  | "REVISION_DELETE_IMPORT_ACTIVE"
  | "PROJECT_NOT_FOUND"
  | "PROJECT_ARCHIVED"
  | "CONTRACTOR_NOT_FOUND"
  | "CONTRACTOR_ARCHIDOC_ORPHANED"
  | "LOT_NOT_FOUND"
  | "ARCHIDOC_TECHNICAL_LOT_NOT_FOUND"
  | "ARCHIDOC_TECHNICAL_LOT_INACTIVE"
  | "STORAGE_KEY_MISSING"
  | "REVISION_SOURCE_INVALID"
  | "REVISION_SOURCE_UNAVAILABLE"
  | "AI_TRANSIENT"
  | "DEVIS_PARSE_FAILED"
  | "IMPORT_JOB_NOT_FOUND"
  | "IMPORT_JOB_STATUS_CONFLICT";

export class PlanningEnvelopeError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: PlanningEnvelopeErrorCode,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "PlanningEnvelopeError";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface RevisionDetail {
  revision: PlanningRevision;
  lines: PlanningRevisionLine[];
  source: PlanningRevisionSource | null;
}

/** Enriched per-revision entry for envelope summary (includes contractor/lot display fields). */
export interface RevisionSummaryEntry extends RevisionDetail {
  contractorName: string | null;
  lotNumber: string | null;
  technicalLot: {
    id: string;
    code: string;
    labelFr: string;
    displayOrder: number;
    isActive: boolean;
    deletedAt: Date | null;
  } | null;
  legacyLotNeedsReview: boolean;
}

export interface EnvelopeSummary {
  envelope: PlanningEnvelope;
  revisions: RevisionSummaryEntry[];
  totals: {
    amountHt: string;
    amountTtc: string;
    byLot: Array<{
      lotId: number | null;
      archidocTechnicalLotId: string | null;
      lotNumber: string | null;
      description: string | null;
      amountHt: string;
      amountTtc: string;
      count: number;
    }>;
  };
}

export interface PlanningImportSummary {
  id: number;
  fileName: string;
  fileSha256: string;
  status: PlanningImportStatus;
  stage: PlanningImportStage;
  revisionId: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  startedAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
}

export interface DeletePlanningUploadedDraftResult {
  revisionId: number;
  projectId: number;
  fileName: string | null;
  storageKeyToDelete: string | null;
  deletedImportJobIds: number[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Snapshot shape (canonical structure stored at approval time)
// ─────────────────────────────────────────────────────────────────────────────

export interface ApprovedSnapshotLine {
  lineNumber: number;
  description: string;
  quantity: string | null;
  unit: string | null;
  unitPriceHt: string | null;
  totalHt: string;
  pdfPageHint: number | null;
  pdfBbox: { x: number; y: number; w: number; h: number } | null;
}

export interface ApprovedSnapshotSource {
  sourceKind: string;
  storageKey: string | null;
  fileName: string | null;
  fileSha256: string | null;
  mimeType: string | null;
  fileSizeBytes: number | null;
  parserVersion: string | null;
  provider: string | null;
  modelId: string | null;
  rawExtraction: unknown;
  confidence: number | null;
  warnings: unknown;
  requiresVerification: boolean;
  verifiedAt: string | null;
  verifiedBy: string | null;
  verificationNote: string | null;
}

export interface ApprovedSnapshot {
  revisionId: number;
  envelopeId: number;
  version: number;
  contractorId: number | null;
  lotId: number | null;
  archidocTechnicalLotId: string | null;
  reference: string | null;
  descriptionFr: string | null;
  documentDate: string | null;
  amountHt: string | null;
  amountTtc: string | null;
  tvaRatePercent: string | null;
  tvaAutoliquidation: boolean;
  supersedesRevisionId: number | null;
  lines: ApprovedSnapshotLine[];
  source: ApprovedSnapshotSource | null;
}

function isApprovedSnapshot(v: unknown): v is ApprovedSnapshot {
  if (typeof v !== "object" || v === null) return false;
  const s = v as Record<string, unknown>;
  const linesAreValid = Array.isArray(s.lines) && s.lines.every((line) => {
    if (typeof line !== "object" || line === null) return false;
    const candidate = line as Record<string, unknown>;
    return (
      typeof candidate.lineNumber === "number" &&
      Number.isInteger(candidate.lineNumber) &&
      candidate.lineNumber > 0 &&
      typeof candidate.description === "string" &&
      typeof candidate.totalHt === "string"
    );
  });
  const sourceIsValid =
    s.source === null ||
    (
      typeof s.source === "object" &&
      typeof (s.source as Record<string, unknown>).sourceKind === "string" &&
      typeof (s.source as Record<string, unknown>).requiresVerification === "boolean"
    );
  return (
    typeof s.revisionId === "number" &&
    typeof s.envelopeId === "number" &&
    typeof s.version === "number" &&
    typeof s.tvaAutoliquidation === "boolean" &&
    linesAreValid &&
    sourceIsValid
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function sha256(data: string): string {
  return crypto.createHash("sha256").update(data, "utf8").digest("hex");
}

function roundStr(v: number): string {
  return String(roundCurrency(v));
}

/** Deterministic JSON serialization with sorted keys (for stable SHA256). */
function stableStringify(obj: unknown): string {
  if (obj === null || obj === undefined) return JSON.stringify(obj);
  if (typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(stableStringify).join(",")}]`;
  const keys = Object.keys(obj as Record<string, unknown>).sort();
  const pairs = keys.map((k) => `${JSON.stringify(k)}:${stableStringify((obj as Record<string, unknown>)[k])}`);
  return `{${pairs.join(",")}}`;
}

function buildApprovedSnapshotSource(
  source: PlanningRevisionSource | null,
): ApprovedSnapshotSource | null {
  if (!source) return null;
  return {
    sourceKind: source.sourceKind,
    storageKey: source.storageKey,
    fileName: source.fileName,
    fileSha256: source.fileSha256,
    mimeType: source.mimeType,
    fileSizeBytes: source.fileSizeBytes,
    parserVersion: source.parserVersion,
    provider: source.provider,
    modelId: source.modelId,
    rawExtraction: source.rawExtraction,
    confidence: source.confidence,
    warnings: source.warnings,
    requiresVerification: source.requiresVerification,
    verifiedAt: source.verifiedAt?.toISOString() ?? null,
    verifiedBy: source.verifiedBy,
    verificationNote: source.verificationNote,
  };
}

/** Build the canonical approved snapshot object for a revision + its lines. */
function buildApprovedSnapshot(
  revision: PlanningRevision,
  lines: PlanningRevisionLine[],
  source: PlanningRevisionSource | null,
): ApprovedSnapshot {
  return {
    revisionId: revision.id,
    envelopeId: revision.envelopeId,
    version: revision.version,
    contractorId: revision.contractorId,
    lotId: revision.lotId,
    archidocTechnicalLotId: revision.archidocTechnicalLotId,
    reference: revision.reference,
    descriptionFr: revision.descriptionFr,
    documentDate: revision.documentDate,
    amountHt: revision.amountHt,
    amountTtc: revision.amountTtc,
    tvaRatePercent: revision.tvaRatePercent,
    tvaAutoliquidation: revision.tvaAutoliquidation,
    supersedesRevisionId: revision.supersedesRevisionId,
    lines: lines.map((l) => ({
      lineNumber: l.lineNumber,
      description: l.description,
      quantity: l.quantity,
      unit: l.unit,
      unitPriceHt: l.unitPriceHt,
      totalHt: l.totalHt,
      pdfPageHint: l.pdfPageHint,
      pdfBbox: l.pdfBbox,
    })),
    source: buildApprovedSnapshotSource(source),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Envelope helpers
// ─────────────────────────────────────────────────────────────────────────────

type TxClient = Parameters<Parameters<typeof db.transaction>[0]>[0];
type TxOrDb = typeof db | TxClient;

async function assertProjectMutable(
  projectId: number,
  tx: TxClient,
  lockMode: "share" | "update" = "share",
): Promise<void> {
  const [project] = await tx
    .select({ id: projects.id, archivedAt: projects.archivedAt })
    .from(projects)
    .where(eq(projects.id, projectId))
    .for(lockMode);

  if (!project) {
    throw new PlanningEnvelopeError(404, "PROJECT_NOT_FOUND", "Project not found");
  }
  if (project.archivedAt) {
    throw new PlanningEnvelopeError(
      409,
      "PROJECT_ARCHIVED",
      "Archived projects are read-only",
      { projectId },
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Durable PDF import progress
// ─────────────────────────────────────────────────────────────────────────────

function toPlanningImportSummary(row: PlanningImportJob): PlanningImportSummary {
  return {
    id: row.id,
    fileName: row.fileName,
    fileSha256: row.fileSha256,
    status: row.status as PlanningImportStatus,
    stage: row.stage as PlanningImportStage,
    revisionId: row.revisionId,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    startedAt: row.startedAt,
    updatedAt: row.updatedAt,
    completedAt: row.completedAt,
  };
}

export interface CreatePlanningImportJobInput {
  projectId: number;
  actor: string;
  fileName: string;
  fileSha256: string;
  mimeType: string;
  fileSizeBytes: number;
}

export async function createPlanningImportJob(
  input: CreatePlanningImportJobInput,
): Promise<PlanningImportSummary> {
  return db.transaction(async (tx) => {
    await assertProjectMutable(input.projectId, tx);
    const [row] = await tx
      .insert(planningImportJobs)
      .values({
        projectId: input.projectId,
        fileName: input.fileName,
        fileSha256: input.fileSha256,
        mimeType: input.mimeType,
        fileSizeBytes: input.fileSizeBytes,
        createdBy: input.actor,
        status: "processing",
        stage: "accepted",
      })
      .returning();
    return toPlanningImportSummary(row);
  });
}

export async function advancePlanningImportStage(
  importJobId: number,
  stage: Exclude<PlanningImportStage, "complete">,
): Promise<PlanningImportSummary | null> {
  const [row] = await db
    .update(planningImportJobs)
    .set({ stage, updatedAt: new Date() })
    .where(and(
      eq(planningImportJobs.id, importJobId),
      eq(planningImportJobs.status, "processing"),
    ))
    .returning();
  return row ? toPlanningImportSummary(row) : null;
}

export async function touchPlanningImportJob(importJobId: number): Promise<void> {
  await db
    .update(planningImportJobs)
    .set({ updatedAt: new Date() })
    .where(and(
      eq(planningImportJobs.id, importJobId),
      eq(planningImportJobs.status, "processing"),
    ));
}

export interface FailPlanningImportJobInput {
  importJobId: number;
  errorCode: string;
  errorMessage: string;
}

export async function failPlanningImportJob(
  input: FailPlanningImportJobInput,
): Promise<PlanningImportSummary | null> {
  const errorCode = input.errorCode.trim().slice(0, 100) || "IMPORT_FAILED";
  const errorMessage = input.errorMessage.trim().slice(0, 500) || "PDF import failed. Choose the file again to retry.";
  const now = new Date();
  const [row] = await db
    .update(planningImportJobs)
    .set({
      status: "failed",
      errorCode,
      errorMessage,
      completedAt: now,
      updatedAt: now,
    })
    .where(and(
      eq(planningImportJobs.id, input.importJobId),
      eq(planningImportJobs.status, "processing"),
    ))
    .returning();
  return row ? toPlanningImportSummary(row) : null;
}

async function markAbandonedPlanningImportsStale(projectId: number, now: Date): Promise<void> {
  const cutoff = new Date(now.getTime() - PLANNING_IMPORT_STALE_AFTER_MS);
  await db
    .update(planningImportJobs)
    .set({
      status: "stale",
      errorCode: "IMPORT_STALE",
      errorMessage: "Processing stopped before completion. Choose the PDF again to retry.",
      completedAt: now,
      updatedAt: now,
    })
    .where(and(
      eq(planningImportJobs.projectId, projectId),
      eq(planningImportJobs.status, "processing"),
      lt(planningImportJobs.updatedAt, cutoff),
    ));
}

export async function getRecentPlanningImports(
  projectId: number,
  requestedLimit = 10,
  now = new Date(),
): Promise<PlanningImportSummary[]> {
  await markAbandonedPlanningImportsStale(projectId, now);
  const limit = Math.max(1, Math.min(20, Math.trunc(requestedLimit)));
  const rows = await db
    .select()
    .from(planningImportJobs)
    .where(eq(planningImportJobs.projectId, projectId))
    .orderBy(desc(planningImportJobs.startedAt), desc(planningImportJobs.id))
    .limit(limit);
  return rows.map(toPlanningImportSummary);
}

/**
 * Get or create envelope for a project.
 * Uses INSERT ... ON CONFLICT DO NOTHING then SELECT to avoid race conditions
 * where two concurrent transactions both try to insert.
 */
export async function ensureEnvelope(
  projectId: number,
  client: TxOrDb = db,
): Promise<PlanningEnvelope> {
  const c = client as typeof db;
  // Try INSERT; ignore duplicate key
  await c
    .insert(planningEnvelopes)
    .values({ projectId })
    .onConflictDoNothing();
  // Now SELECT — always succeeds whether we just inserted or it already existed
  const [row] = await c
    .select()
    .from(planningEnvelopes)
    .where(eq(planningEnvelopes.projectId, projectId));
  if (!row) throw new PlanningEnvelopeError(500, "ENVELOPE_NOT_FOUND", "Failed to ensure envelope");
  return row;
}

/** Get envelope for a project (never creates). Returns null if missing. */
export async function getEnvelopeByProject(projectId: number): Promise<PlanningEnvelope | null> {
  const [row] = await db
    .select()
    .from(planningEnvelopes)
    .where(eq(planningEnvelopes.projectId, projectId));
  return row ?? null;
}

/** Get envelope by id. Returns null if missing. */
export async function getEnvelopeById(id: number): Promise<PlanningEnvelope | null> {
  const [row] = await db
    .select()
    .from(planningEnvelopes)
    .where(eq(planningEnvelopes.id, id));
  return row ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Read helpers
// ─────────────────────────────────────────────────────────────────────────────

async function getRevisionDetailWith(
  revisionId: number,
  client: TxOrDb,
): Promise<RevisionDetail | null> {
  const c = client as typeof db;
  const [revision] = await c
    .select()
    .from(planningRevisions)
    .where(eq(planningRevisions.id, revisionId));
  if (!revision) return null;

  const lines = await c
    .select()
    .from(planningRevisionLines)
    .where(eq(planningRevisionLines.revisionId, revisionId))
    .orderBy(planningRevisionLines.lineNumber);

  const [source] = await c
    .select()
    .from(planningRevisionSources)
    .where(eq(planningRevisionSources.revisionId, revisionId));

  return { revision, lines, source: source ?? null };
}

async function getRevisionDetail(revisionId: number): Promise<RevisionDetail | null> {
  return getRevisionDetailWith(revisionId, db);
}

export async function getRevisionById(id: number): Promise<RevisionDetail | null> {
  return getRevisionDetail(id);
}

/**
 * Permanently remove a disposable PDF-uploaded draft.
 *
 * The preliminary identity read is intentionally followed by locked re-reads
 * inside the transaction. It gives us the project row to lock first (the same
 * lock order used by other planning mutations) without trusting stale state.
 */
export async function deletePlanningUploadedDraft(input: {
  revisionId: number;
  expectedVersion: number;
}): Promise<DeletePlanningUploadedDraftResult> {
  const [identity] = await db
    .select({ projectId: planningEnvelopes.projectId })
    .from(planningRevisions)
    .innerJoin(planningEnvelopes, eq(planningEnvelopes.id, planningRevisions.envelopeId))
    .where(eq(planningRevisions.id, input.revisionId));

  if (!identity) {
    throw new PlanningEnvelopeError(404, "REVISION_NOT_FOUND", "Planning revision not found");
  }

  return db.transaction(async (tx) => {
    // Import/PDF creation takes a shared lock on this row. The conflicting
    // exclusive lock closes the empty-result race around the active-import
    // check and keeps post-commit object cleanup safe.
    await assertProjectMutable(identity.projectId, tx, "update");

    const [envelope] = await tx
      .select()
      .from(planningEnvelopes)
      .where(eq(planningEnvelopes.projectId, identity.projectId))
      .for("share");
    if (!envelope) {
      throw new PlanningEnvelopeError(404, "ENVELOPE_NOT_FOUND", "Planning envelope not found");
    }

    const [revision] = await tx
      .select()
      .from(planningRevisions)
      .where(eq(planningRevisions.id, input.revisionId))
      .for("update");
    if (!revision) {
      throw new PlanningEnvelopeError(404, "REVISION_NOT_FOUND", "Planning revision not found");
    }
    if (revision.envelopeId !== envelope.id) {
      throw new PlanningEnvelopeError(
        409,
        "REVISION_WRONG_PROJECT",
        "Planning revision belongs to a different project",
      );
    }
    if (revision.version !== input.expectedVersion) {
      throw new PlanningEnvelopeError(
        409,
        "REVISION_CAS_CONFLICT",
        `Version conflict: expected ${input.expectedVersion}, got ${revision.version}`,
        {
          expectedVersion: input.expectedVersion,
          currentVersion: revision.version,
        },
      );
    }
    if (
      revision.status !== "draft"
      || revision.promotedDevisId != null
      || revision.promotedAt != null
      || revision.promotedBy != null
      || revision.supersedesRevisionId != null
    ) {
      throw new PlanningEnvelopeError(
        409,
        "REVISION_DELETE_NOT_ALLOWED",
        "Only an unused uploaded draft can be deleted",
        { currentStatus: revision.status },
      );
    }

    const [dependentRevision] = await tx
      .select({ id: planningRevisions.id })
      .from(planningRevisions)
      .where(eq(planningRevisions.supersedesRevisionId, revision.id))
      .for("share");
    if (dependentRevision) {
      throw new PlanningEnvelopeError(
        409,
        "REVISION_DELETE_NOT_ALLOWED",
        "This draft is part of a revision history and cannot be deleted",
      );
    }

    const [linkedDevis] = await tx
      .select({ id: devis.id })
      .from(devis)
      .where(eq(devis.sourcePlanningRevisionId, revision.id))
      .for("share");
    if (linkedDevis) {
      throw new PlanningEnvelopeError(
        409,
        "REVISION_DELETE_NOT_ALLOWED",
        "This draft is linked to a live devis and cannot be deleted",
      );
    }

    const [source] = await tx
      .select()
      .from(planningRevisionSources)
      .where(eq(planningRevisionSources.revisionId, revision.id))
      .for("update");
    if (
      !source
      || source.sourceKind !== "pdf_upload"
      || !source.storageKey
      || !source.fileSha256
    ) {
      throw new PlanningEnvelopeError(
        409,
        "REVISION_DELETE_NOT_ALLOWED",
        "Only a draft created from an uploaded PDF can be deleted",
      );
    }

    const activeImports = await tx
      .select({ id: planningImportJobs.id })
      .from(planningImportJobs)
      .where(and(
        eq(planningImportJobs.projectId, identity.projectId),
        eq(planningImportJobs.fileSha256, source.fileSha256),
        eq(planningImportJobs.status, "processing"),
      ))
      .for("update");
    if (activeImports.length > 0) {
      throw new PlanningEnvelopeError(
        409,
        "REVISION_DELETE_IMPORT_ACTIVE",
        "This PDF is still being processed. Wait for the import to finish, then try again.",
      );
    }

    const deletedImportJobs = await tx
      .delete(planningImportJobs)
      .where(eq(planningImportJobs.revisionId, revision.id))
      .returning({ id: planningImportJobs.id });

    const deletedRevisions = await tx
      .delete(planningRevisions)
      .where(and(
        eq(planningRevisions.id, revision.id),
        eq(planningRevisions.version, input.expectedVersion),
      ))
      .returning({ id: planningRevisions.id });
    if (deletedRevisions.length !== 1) {
      throw new PlanningEnvelopeError(
        409,
        "REVISION_CAS_CONFLICT",
        "The planning draft changed before it could be deleted",
      );
    }

    const [sharedSource] = await tx
      .select({ id: planningRevisionSources.id })
      .from(planningRevisionSources)
      .where(eq(planningRevisionSources.storageKey, source.storageKey))
      .limit(1);

    return {
      revisionId: revision.id,
      projectId: identity.projectId,
      fileName: source.fileName,
      storageKeyToDelete: sharedSource ? null : source.storageKey,
      deletedImportJobIds: deletedImportJobs.map((row) => row.id),
    };
  });
}

export async function getEnvelopeSummary(projectId: number): Promise<EnvelopeSummary | null> {
  const envelope = await getEnvelopeByProject(projectId);
  if (!envelope) return null;

  const revisionRows = await db
    .select()
    .from(planningRevisions)
    .where(eq(planningRevisions.envelopeId, envelope.id))
    .orderBy(planningRevisions.createdAt);

  // Collect unique contractor/lot IDs for batch lookup
  const contractorIdSet = new Set<number>();
  const lotIdSet = new Set<number>();
  const technicalLotIdSet = new Set<string>();
  for (const r of revisionRows) {
    if (r.contractorId != null) contractorIdSet.add(r.contractorId);
    if (r.lotId != null) lotIdSet.add(r.lotId);
    if (r.archidocTechnicalLotId != null) technicalLotIdSet.add(r.archidocTechnicalLotId);
  }
  const contractorIds = Array.from(contractorIdSet);
  const lotIds = Array.from(lotIdSet);
  const technicalLotIds = Array.from(technicalLotIdSet);

  // Batch-fetch contractor names and lot info
  const contractorMap = new Map<number, string>();
  if (contractorIds.length > 0) {
    const rows = await db
      .select({ id: contractors.id, name: contractors.name })
      .from(contractors)
      .where(sql`${contractors.id} = ANY(${sql.raw(`ARRAY[${contractorIds.join(",")}]::int[]`)})`)
    ;
    for (const r of rows) contractorMap.set(r.id, r.name);
  }

  const lotMap = new Map<number, { lotNumber: string; descriptionFr: string | null }>();
  if (lotIds.length > 0) {
    const rows = await db
      .select({ id: lots.id, lotNumber: lots.lotNumber, descriptionFr: lots.descriptionFr })
      .from(lots)
      .where(sql`${lots.id} = ANY(${sql.raw(`ARRAY[${lotIds.join(",")}]::int[]`)})`)
    ;
    for (const r of rows) lotMap.set(r.id, { lotNumber: r.lotNumber, descriptionFr: r.descriptionFr ?? null });
  }

  type TechnicalLotSummary = {
    id: string;
    code: string;
    labelFr: string;
    displayOrder: number;
    isActive: boolean;
    deletedAt: Date | null;
  };
  const technicalLotMap = new Map<string, TechnicalLotSummary>();
  if (technicalLotIds.length > 0) {
    const rows = await db
      .select({
        id: archidocTechnicalLots.archidocId,
        code: archidocTechnicalLots.code,
        labelFr: archidocTechnicalLots.labelFr,
        displayOrder: archidocTechnicalLots.displayOrder,
        isActive: archidocTechnicalLots.isActive,
        deletedAt: archidocTechnicalLots.deletedAt,
      })
      .from(archidocTechnicalLots)
      .where(inArray(archidocTechnicalLots.archidocId, technicalLotIds));
    for (const row of rows) technicalLotMap.set(row.id, row);
  }

  const revisions: RevisionSummaryEntry[] = await Promise.all(
    revisionRows.map(async (rev) => {
      const lines = await db
        .select()
        .from(planningRevisionLines)
        .where(eq(planningRevisionLines.revisionId, rev.id))
        .orderBy(planningRevisionLines.lineNumber);
      const [source] = await db
        .select()
        .from(planningRevisionSources)
        .where(eq(planningRevisionSources.revisionId, rev.id));
      return {
        revision: rev,
        lines,
        source: source ?? null,
        contractorName: rev.contractorId ? (contractorMap.get(rev.contractorId) ?? null) : null,
        lotNumber: rev.archidocTechnicalLotId
          ? (technicalLotMap.get(rev.archidocTechnicalLotId)?.code ?? null)
          : rev.lotId
            ? (lotMap.get(rev.lotId)?.lotNumber ?? null)
            : null,
        technicalLot: rev.archidocTechnicalLotId
          ? (technicalLotMap.get(rev.archidocTechnicalLotId) ?? null)
          : null,
        legacyLotNeedsReview: rev.lotId != null && rev.archidocTechnicalLotId == null,
      };
    }),
  );

  // Compute totals from approved (non-superseded) revisions only
  const approved = revisions.filter((r) => r.revision.status === "approved");
  let totalHtNum = 0;
  let totalTtcNum = 0;

  // byLot: ArchiDoc technical lot when present, otherwise legacy project lot.
  const byLotMap = new Map<
    string,
    {
      lotId: number | null;
      archidocTechnicalLotId: string | null;
      amountHt: number;
      amountTtc: number;
      count: number;
      lotNumber: string | null;
      description: string | null;
    }
  >();

  for (const { revision } of approved) {
    const ht = Number(revision.amountHt ?? "0");
    const ttc = Number(revision.amountTtc ?? "0");
    totalHtNum += ht;
    totalTtcNum += ttc;
    const technicalLot = revision.archidocTechnicalLotId
      ? technicalLotMap.get(revision.archidocTechnicalLotId)
      : undefined;
    const legacyLot = revision.lotId != null ? lotMap.get(revision.lotId) : undefined;
    const key = revision.archidocTechnicalLotId
      ? `archidoc:${revision.archidocTechnicalLotId}`
      : revision.lotId != null
        ? `legacy:${revision.lotId}`
        : "unassigned";
    const existing = byLotMap.get(key);
    if (existing) {
      existing.amountHt += ht;
      existing.amountTtc += ttc;
      existing.count += 1;
    } else {
      byLotMap.set(key, {
        lotId: revision.lotId,
        archidocTechnicalLotId: revision.archidocTechnicalLotId,
        amountHt: ht,
        amountTtc: ttc,
        count: 1,
        lotNumber: technicalLot?.code ?? legacyLot?.lotNumber ?? null,
        description: technicalLot?.labelFr ?? legacyLot?.descriptionFr ?? null,
      });
    }
  }

  const byLot = Array.from(byLotMap.values()).map((val) => ({
    lotId: val.lotId,
    archidocTechnicalLotId: val.archidocTechnicalLotId,
    lotNumber: val.lotNumber,
    description: val.description,
    amountHt: roundStr(val.amountHt),
    amountTtc: roundStr(val.amountTtc),
    count: val.count,
  }));

  return {
    envelope,
    revisions,
    totals: {
      amountHt: roundStr(totalHtNum),
      amountTtc: roundStr(totalTtcNum),
      byLot,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Append event helper
// ─────────────────────────────────────────────────────────────────────────────

async function appendEvent(
  tx: TxClient,
  revisionId: number,
  action: string,
  actor: string | undefined,
  payload?: Record<string, unknown>,
): Promise<void> {
  await tx.insert(planningRevisionEvents).values({
    revisionId,
    action,
    actor: actor ?? null,
    payload: payload ?? null,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation helpers
// ─────────────────────────────────────────────────────────────────────────────

async function validateContractorForProject(
  contractorId: number | null | undefined,
  _projectId: number,
  tx: TxClient,
  options: { allowOrphaned?: boolean } = {},
): Promise<void> {
  if (!contractorId) return;
  const [row] = await tx
    .select({
      id: contractors.id,
      archidocOrphanedAt: contractors.archidocOrphanedAt,
    })
    .from(contractors)
    .where(eq(contractors.id, contractorId));
  if (!row) {
    throw new PlanningEnvelopeError(404, "CONTRACTOR_NOT_FOUND", `Contractor ${contractorId} not found`);
  }
  if (row.archidocOrphanedAt && !options.allowOrphaned) {
    throw new PlanningEnvelopeError(
      422,
      "CONTRACTOR_ARCHIDOC_ORPHANED",
      `Contractor ${contractorId} is no longer active in ArchiDoc`,
    );
  }
}

async function validateLotForProject(
  lotId: number | null | undefined,
  projectId: number,
  tx: TxClient,
): Promise<void> {
  if (!lotId) return;
  const [row] = await tx.select({ id: lots.id, projectId: lots.projectId }).from(lots).where(eq(lots.id, lotId));
  if (!row) {
    throw new PlanningEnvelopeError(404, "LOT_NOT_FOUND", `Lot ${lotId} not found`);
  }
  if (row.projectId !== projectId) {
    throw new PlanningEnvelopeError(
      422,
      "REVISION_CROSS_PROJECT_LOT",
      `Lot ${lotId} belongs to a different project`,
      { lotId, projectId },
    );
  }
}

async function validateTechnicalLotForSelection(
  archidocTechnicalLotId: string | null | undefined,
  tx: TxClient,
  options: { allowInactiveId?: string | null } = {},
): Promise<void> {
  if (!archidocTechnicalLotId) return;
  const [row] = await tx
    .select({
      id: archidocTechnicalLots.archidocId,
      isActive: archidocTechnicalLots.isActive,
      deletedAt: archidocTechnicalLots.deletedAt,
    })
    .from(archidocTechnicalLots)
    .where(eq(archidocTechnicalLots.archidocId, archidocTechnicalLotId))
    .for("share");
  if (!row) {
    throw new PlanningEnvelopeError(
      404,
      "ARCHIDOC_TECHNICAL_LOT_NOT_FOUND",
      "The selected ArchiDoc technical lot is no longer available",
      { archidocTechnicalLotId },
    );
  }
  if (
    (!row.isActive || row.deletedAt != null)
    && options.allowInactiveId !== archidocTechnicalLotId
  ) {
    throw new PlanningEnvelopeError(
      422,
      "ARCHIDOC_TECHNICAL_LOT_INACTIVE",
      "The selected ArchiDoc technical lot is no longer active",
      { archidocTechnicalLotId },
    );
  }
}

function validatePositiveAmounts(revision: {
  amountHt: string | null;
  amountTtc: string | null;
}): void {
  const ht = Number(revision.amountHt ?? "0");
  const ttc = Number(revision.amountTtc ?? "0");
  if (ht <= 0) {
    throw new PlanningEnvelopeError(422, "REVISION_VALIDATION_FAILED", "amountHt must be positive");
  }
  if (ttc <= 0) {
    throw new PlanningEnvelopeError(422, "REVISION_VALIDATION_FAILED", "amountTtc must be positive");
  }
  if (ttc < ht) {
    throw new PlanningEnvelopeError(422, "REVISION_VALIDATION_FAILED", "amountTtc must be >= amountHt");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Create manual draft revision
// ─────────────────────────────────────────────────────────────────────────────

export interface CreateManualRevisionInput {
  projectId: number;
  actor: string;
  contractorId?: number | null;
  lotId?: number | null;
  archidocTechnicalLotId?: string | null;
  reference?: string | null;
  descriptionFr?: string | null;
  documentDate?: string | null;
  amountHt?: string | null;
  amountTtc?: string | null;
  tvaRatePercent?: string | null;
  tvaAutoliquidation?: boolean;
  supersedesRevisionId?: number | null;
  lines?: Array<{
    lineNumber: number;
    description: string;
    quantity?: string | null;
    unit?: string | null;
    unitPriceHt?: string | null;
    totalHt: string;
    pdfPageHint?: number | null;
    pdfBbox?: { x: number; y: number; w: number; h: number } | null;
  }>;
}

export async function createManualRevision(input: CreateManualRevisionInput): Promise<RevisionDetail> {
  return db.transaction(async (tx) => {
    await assertProjectMutable(input.projectId, tx);
    const envelope = await ensureEnvelope(input.projectId, tx);

    // Validate cross-project lot
    await validateLotForProject(input.lotId, input.projectId, tx);
    await validateTechnicalLotForSelection(input.archidocTechnicalLotId, tx);

    // Validate contractor exists
    await validateContractorForProject(input.contractorId, input.projectId, tx);

    // Validate supersedesRevisionId belongs to same envelope
    if (input.supersedesRevisionId) {
      const [sup] = await tx
        .select()
        .from(planningRevisions)
        .where(eq(planningRevisions.id, input.supersedesRevisionId));
      if (!sup || sup.envelopeId !== envelope.id) {
        throw new PlanningEnvelopeError(
          422,
          "REVISION_SUPERSEDES_MISMATCH",
          "supersedesRevisionId does not belong to this project's envelope",
        );
      }
      if (sup.status !== "approved") {
        throw new PlanningEnvelopeError(
          409,
          "REVISION_STATUS_CONFLICT",
          "A new revision can only supersede an approved revision",
          { supersedesRevisionId: sup.id, currentStatus: sup.status },
        );
      }
    }

    const [revision] = await tx
      .insert(planningRevisions)
      .values({
        envelopeId: envelope.id,
        version: 1,
        status: "draft",
        contractorId: input.contractorId ?? null,
        lotId: input.lotId ?? null,
        archidocTechnicalLotId: input.archidocTechnicalLotId ?? null,
        reference: input.reference ?? null,
        descriptionFr: input.descriptionFr ?? null,
        documentDate: input.documentDate ?? null,
        amountHt: input.amountHt ?? null,
        amountTtc: input.amountTtc ?? null,
        tvaRatePercent: input.tvaRatePercent ?? null,
        tvaAutoliquidation: input.tvaAutoliquidation ?? false,
        supersedesRevisionId: input.supersedesRevisionId ?? null,
        createdBy: input.actor,
      })
      .returning();

    // Create manual source record
    await tx.insert(planningRevisionSources).values({
      revisionId: revision.id,
      sourceKind: "manual",
      requiresVerification: false,
    });

    // Create lines
    const lines: PlanningRevisionLine[] = [];
    if (input.lines && input.lines.length > 0) {
      const lineValues = input.lines.map((l) => ({
        revisionId: revision.id,
        lineNumber: l.lineNumber,
        description: l.description,
        quantity: l.quantity ?? null,
        unit: l.unit ?? null,
        unitPriceHt: l.unitPriceHt ?? null,
        totalHt: l.totalHt,
        pdfPageHint: l.pdfPageHint ?? null,
        pdfBbox: l.pdfBbox ?? null,
      }));
      const inserted = await tx.insert(planningRevisionLines).values(lineValues).returning();
      lines.push(...inserted);
    }

    await appendEvent(tx, revision.id, "created", input.actor, { sourceKind: "manual" });

    const [source] = await tx
      .select()
      .from(planningRevisionSources)
      .where(eq(planningRevisionSources.revisionId, revision.id));

    return { revision, lines, source: source ?? null };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Create PDF draft revision (from import)
// ─────────────────────────────────────────────────────────────────────────────

export interface CreatePdfRevisionInput {
  projectId: number;
  actor: string;
  importJobId?: number;
  storageKey: string;
  fileName: string;
  fileSha256: string;
  mimeType: string;
  fileSizeBytes: number;
  parserVersion: string;
  provider: string;
  modelId: string;
  rawExtraction: Record<string, unknown>;
  confidence: number;
  warnings: unknown[];
  /** Set only when the PDF is being parsed again from an existing immutable source. */
  rescrapedFromRevisionId?: number;
  expectedSourceVersion?: number;
  // Corrected/extracted header values
  contractorId?: number | null;
  reference?: string | null;
  descriptionFr?: string | null;
  documentDate?: string | null;
  amountHt?: string | null;
  amountTtc?: string | null;
  tvaRatePercent?: string | null;
  tvaAutoliquidation?: boolean;
  lines?: Array<{
    lineNumber: number;
    description: string;
    quantity?: string | null;
    unit?: string | null;
    unitPriceHt?: string | null;
    totalHt: string;
    pdfPageHint?: number | null;
    pdfBbox?: { x: number; y: number; w: number; h: number } | null;
  }>;
}

export async function createPdfRevision(input: CreatePdfRevisionInput): Promise<RevisionDetail> {
  if (!input.mimeType.trim() || input.fileSizeBytes <= 0) {
    throw new PlanningEnvelopeError(
      422,
      "REVISION_VALIDATION_FAILED",
      "PDF source MIME type and positive file size are required",
    );
  }
  // requiresVerification if confidence below threshold OR any warnings present
  const requiresVerification =
    input.confidence < LOW_CONFIDENCE_THRESHOLD || input.warnings.length > 0;

  return db.transaction(async (tx) => {
    await assertProjectMutable(input.projectId, tx);

    let rescrapeSource: PlanningRevision | null = null;
    if (input.rescrapedFromRevisionId != null) {
      const [sourceRevision] = await tx
        .select()
        .from(planningRevisions)
        .where(eq(planningRevisions.id, input.rescrapedFromRevisionId))
        .for("update");
      if (!sourceRevision) {
        throw new PlanningEnvelopeError(404, "REVISION_NOT_FOUND", "Revision not found");
      }
      const [sourceEnvelope] = await tx
        .select()
        .from(planningEnvelopes)
        .where(eq(planningEnvelopes.id, sourceRevision.envelopeId));
      if (!sourceEnvelope || sourceEnvelope.projectId !== input.projectId) {
        throw new PlanningEnvelopeError(404, "REVISION_NOT_FOUND", "Revision not found");
      }
      if (
        input.expectedSourceVersion == null
        || sourceRevision.version !== input.expectedSourceVersion
      ) {
        throw new PlanningEnvelopeError(
          409,
          "REVISION_CAS_CONFLICT",
          `Version conflict: expected ${input.expectedSourceVersion}, got ${sourceRevision.version}`,
          {
            expectedVersion: input.expectedSourceVersion,
            currentVersion: sourceRevision.version,
          },
        );
      }
      if (!["draft", "reviewed", "approved"].includes(sourceRevision.status)) {
        throw new PlanningEnvelopeError(
          409,
          "REVISION_STATUS_CONFLICT",
          `This ${sourceRevision.status} revision cannot be re-scraped`,
          { currentStatus: sourceRevision.status },
        );
      }
      const [immutableSource] = await tx
        .select()
        .from(planningRevisionSources)
        .where(eq(planningRevisionSources.revisionId, sourceRevision.id));
      if (
        !immutableSource
        || immutableSource.sourceKind !== "pdf_upload"
        || !immutableSource.storageKey
        || immutableSource.storageKey !== input.storageKey
        || immutableSource.fileSha256 !== input.fileSha256
      ) {
        throw new PlanningEnvelopeError(
          422,
          "REVISION_SOURCE_INVALID",
          "Revision does not have the expected immutable PDF source",
        );
      }

      // Source-row locking serializes concurrent re-scrapes. The event/source
      // lookup makes the operation idempotent for one source version and one
      // parser version while still allowing a later parser version to be run.
      const [existingRescrape] = await tx
        .select({ revisionId: planningRevisionEvents.revisionId })
        .from(planningRevisionEvents)
        .innerJoin(
          planningRevisionSources,
          eq(planningRevisionSources.revisionId, planningRevisionEvents.revisionId),
        )
        .where(and(
          eq(planningRevisionEvents.action, "created"),
          eq(planningRevisionSources.parserVersion, input.parserVersion),
          sql`${planningRevisionEvents.payload}->>'rescrapedFromRevisionId' = ${String(sourceRevision.id)}`,
          sql`${planningRevisionEvents.payload}->>'sourceRevisionVersion' = ${String(sourceRevision.version)}`,
        ))
        .orderBy(desc(planningRevisionEvents.id))
        .limit(1);
      if (existingRescrape) {
        const existingDetail = await getRevisionDetailWith(existingRescrape.revisionId, tx);
        if (existingDetail) return existingDetail;
      }
      rescrapeSource = sourceRevision;
    }

    if (input.importJobId != null) {
      const [job] = await tx
        .select()
        .from(planningImportJobs)
        .where(eq(planningImportJobs.id, input.importJobId))
        .for("update");
      if (!job || job.projectId !== input.projectId) {
        throw new PlanningEnvelopeError(404, "IMPORT_JOB_NOT_FOUND", "Planning import job not found");
      }
      if (
        !["processing", "stale"].includes(job.status)
        || job.fileSha256 !== input.fileSha256
        || job.fileName !== input.fileName
      ) {
        throw new PlanningEnvelopeError(
          409,
          "IMPORT_JOB_STATUS_CONFLICT",
          "Planning import job cannot be completed from this source",
        );
      }
    }

    const envelope = await ensureEnvelope(input.projectId, tx);

    // Validate contractor if detected
    await validateContractorForProject(input.contractorId, input.projectId, tx);

    const [revision] = await tx
      .insert(planningRevisions)
      .values({
        envelopeId: envelope.id,
        version: 1,
        status: "draft",
        contractorId: input.contractorId ?? null,
        lotId: null, // Never infer lot from extraction
        reference: input.reference ?? null,
        descriptionFr: input.descriptionFr ?? null,
        documentDate: input.documentDate ?? null,
        amountHt: input.amountHt ?? null,
        amountTtc: input.amountTtc ?? null,
        tvaRatePercent: input.tvaRatePercent ?? null,
        tvaAutoliquidation: input.tvaAutoliquidation ?? false,
        supersedesRevisionId: rescrapeSource?.status === "approved"
          ? rescrapeSource.id
          : null,
        createdBy: input.actor,
      })
      .returning();

    // Immutable source record
    await tx.insert(planningRevisionSources).values({
      revisionId: revision.id,
      sourceKind: "pdf_upload",
      storageKey: input.storageKey,
      fileName: input.fileName,
      fileSha256: input.fileSha256,
      mimeType: input.mimeType,
      fileSizeBytes: input.fileSizeBytes,
      parserVersion: input.parserVersion,
      provider: input.provider,
      modelId: input.modelId,
      rawExtraction: input.rawExtraction,
      confidence: input.confidence,
      warnings: input.warnings,
      requiresVerification,
    });

    const lines: PlanningRevisionLine[] = [];
    if (input.lines && input.lines.length > 0) {
      const lineValues = input.lines.map((l) => ({
        revisionId: revision.id,
        lineNumber: l.lineNumber,
        description: l.description,
        quantity: l.quantity ?? null,
        unit: l.unit ?? null,
        unitPriceHt: l.unitPriceHt ?? null,
        totalHt: l.totalHt,
        pdfPageHint: l.pdfPageHint ?? null,
        pdfBbox: l.pdfBbox ?? null,
      }));
      const inserted = await tx.insert(planningRevisionLines).values(lineValues).returning();
      lines.push(...inserted);
    }

    await appendEvent(tx, revision.id, "created", input.actor, {
      sourceKind: "pdf_upload",
      confidence: input.confidence,
      requiresVerification,
      ...(rescrapeSource ? {
        rescrapedFromRevisionId: rescrapeSource.id,
        sourceRevisionVersion: rescrapeSource.version,
        sourceFileSha256: input.fileSha256,
        sourceParserVersion: input.parserVersion,
      } : {}),
    });

    const [source] = await tx
      .select()
      .from(planningRevisionSources)
      .where(eq(planningRevisionSources.revisionId, revision.id));

    if (input.importJobId != null) {
      const now = new Date();
      const [completedJob] = await tx
        .update(planningImportJobs)
        .set({
          status: "succeeded",
          stage: "complete",
          revisionId: revision.id,
          errorCode: null,
          errorMessage: null,
          completedAt: now,
          updatedAt: now,
        })
        .where(and(
          eq(planningImportJobs.id, input.importJobId),
          inArray(planningImportJobs.status, ["processing", "stale"]),
        ))
        .returning({ id: planningImportJobs.id });
      if (!completedJob) {
        throw new PlanningEnvelopeError(
          409,
          "IMPORT_JOB_STATUS_CONFLICT",
          "Planning import job changed before completion",
        );
      }
    }

    return { revision, lines, source: source ?? null };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// PATCH revision (edit header / lines)
// ─────────────────────────────────────────────────────────────────────────────

export interface PatchRevisionInput {
  revisionId: number;
  projectId: number;
  actor: string;
  expectedVersion: number;
  contractorId?: number | null;
  lotId?: number | null;
  archidocTechnicalLotId?: string | null;
  reference?: string | null;
  descriptionFr?: string | null;
  documentDate?: string | null;
  amountHt?: string | null;
  amountTtc?: string | null;
  tvaRatePercent?: string | null;
  tvaAutoliquidation?: boolean;
  lines?: Array<{
    lineNumber: number;
    description: string;
    quantity?: string | null;
    unit?: string | null;
    unitPriceHt?: string | null;
    totalHt: string;
    pdfPageHint?: number | null;
    pdfBbox?: { x: number; y: number; w: number; h: number } | null;
  }>;
}

// All header + lines fields that constitute a material edit (any change = regress reviewed → draft)
const PATCH_HEADER_FIELDS = [
  "contractorId", "lotId", "archidocTechnicalLotId", "reference", "descriptionFr", "documentDate",
  "amountHt", "amountTtc", "tvaRatePercent", "tvaAutoliquidation",
] as const;

export async function patchRevision(input: PatchRevisionInput): Promise<RevisionDetail> {
  // Reject patches containing only expectedVersion (no actual edits)
  const editableKeys = [...PATCH_HEADER_FIELDS, "lines"] as const;
  const hasAnyEdit = editableKeys.some((k) => k in input);
  if (!hasAnyEdit) {
    throw new PlanningEnvelopeError(422, "REVISION_EMPTY_PATCH", "Patch must include at least one editable field");
  }

  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(planningRevisions)
      .where(eq(planningRevisions.id, input.revisionId))
      .for("update");

    if (!current) {
      throw new PlanningEnvelopeError(404, "REVISION_NOT_FOUND", "Revision not found");
    }

    // Verify belongs to the correct project
    const [envelope] = await tx
      .select()
      .from(planningEnvelopes)
      .where(eq(planningEnvelopes.id, current.envelopeId));
    if (!envelope || envelope.projectId !== input.projectId) {
      throw new PlanningEnvelopeError(403, "REVISION_WRONG_PROJECT", "Revision does not belong to this project");
    }
    await assertProjectMutable(input.projectId, tx);

    if (current.status === "approved" || current.status === "superseded") {
      throw new PlanningEnvelopeError(
        409,
        "REVISION_APPROVED_IMMUTABLE",
        `Cannot edit a ${current.status} revision`,
      );
    }

    // CAS check
    if (current.version !== input.expectedVersion) {
      throw new PlanningEnvelopeError(
        409,
        "REVISION_CAS_CONFLICT",
        `Version conflict: expected ${input.expectedVersion}, got ${current.version}`,
        { expectedVersion: input.expectedVersion, currentVersion: current.version },
      );
    }

    // Validate cross-project lot
    await validateLotForProject(input.lotId, input.projectId, tx);
    await validateTechnicalLotForSelection(input.archidocTechnicalLotId, tx, {
      allowInactiveId: current.archidocTechnicalLotId,
    });
    await validateContractorForProject(input.contractorId, input.projectId, tx, {
      allowOrphaned: input.contractorId === current.contractorId,
    });

    // ANY patch of a reviewed revision is material and regresses to draft
    // (reference, description, date, lines — all can affect the approved snapshot)
    const isReviewed = current.status === "reviewed";
    const newStatus = isReviewed ? "draft" : current.status;
    const isMaterialEdit = isReviewed; // always material for reviewed

    const updates: Partial<typeof planningRevisions.$inferInsert> = {
      version: current.version + 1,
      status: newStatus,
      updatedAt: new Date(),
    };

    if ("contractorId" in input) updates.contractorId = input.contractorId ?? null;
    if ("lotId" in input) updates.lotId = input.lotId ?? null;
    if ("archidocTechnicalLotId" in input) {
      updates.archidocTechnicalLotId = input.archidocTechnicalLotId ?? null;
    }
    if ("reference" in input) updates.reference = input.reference ?? null;
    if ("descriptionFr" in input) updates.descriptionFr = input.descriptionFr ?? null;
    if ("documentDate" in input) updates.documentDate = input.documentDate ?? null;
    if ("amountHt" in input) updates.amountHt = input.amountHt ?? null;
    if ("amountTtc" in input) updates.amountTtc = input.amountTtc ?? null;
    if ("tvaRatePercent" in input) updates.tvaRatePercent = input.tvaRatePercent ?? null;
    if ("tvaAutoliquidation" in input) updates.tvaAutoliquidation = input.tvaAutoliquidation;

    // Clear reviewer fields if regressing to draft
    if (isReviewed) {
      updates.reviewedBy = null;
      updates.reviewedAt = null;
    }

    await tx.update(planningRevisions).set(updates).where(eq(planningRevisions.id, input.revisionId));

    // Replace lines if provided
    if (input.lines !== undefined) {
      await tx.delete(planningRevisionLines).where(eq(planningRevisionLines.revisionId, input.revisionId));
      if (input.lines.length > 0) {
        await tx.insert(planningRevisionLines).values(
          input.lines.map((l) => ({
            revisionId: input.revisionId,
            lineNumber: l.lineNumber,
            description: l.description,
            quantity: l.quantity ?? null,
            unit: l.unit ?? null,
            unitPriceHt: l.unitPriceHt ?? null,
            totalHt: l.totalHt,
            pdfPageHint: l.pdfPageHint ?? null,
            pdfBbox: l.pdfBbox ?? null,
          })),
        );
      }
    }

    await appendEvent(tx, input.revisionId, "edited", input.actor, {
      isMaterialEdit,
      regressedToDraft: isReviewed,
    });

    return (await getRevisionDetailWith(input.revisionId, tx))!;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Review (draft → reviewed)
// ─────────────────────────────────────────────────────────────────────────────

export interface ReviewRevisionInput {
  revisionId: number;
  projectId: number;
  actor: string;
  expectedVersion: number;
  verificationNote?: string;
}

export async function reviewRevision(input: ReviewRevisionInput): Promise<RevisionDetail> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(planningRevisions)
      .where(eq(planningRevisions.id, input.revisionId))
      .for("update");

    if (!current) {
      throw new PlanningEnvelopeError(404, "REVISION_NOT_FOUND", "Revision not found");
    }

    const [envelope] = await tx
      .select()
      .from(planningEnvelopes)
      .where(eq(planningEnvelopes.id, current.envelopeId));
    if (!envelope || envelope.projectId !== input.projectId) {
      throw new PlanningEnvelopeError(403, "REVISION_WRONG_PROJECT", "Revision does not belong to this project");
    }
    await assertProjectMutable(input.projectId, tx);

    if (current.status !== "draft") {
      throw new PlanningEnvelopeError(
        409,
        "REVISION_STATUS_CONFLICT",
        `Only draft revisions can be reviewed (current: ${current.status})`,
      );
    }

    if (current.version !== input.expectedVersion) {
      throw new PlanningEnvelopeError(
        409,
        "REVISION_CAS_CONFLICT",
        `Version conflict: expected ${input.expectedVersion}, got ${current.version}`,
        { expectedVersion: input.expectedVersion, currentVersion: current.version },
      );
    }

    // Validate required fields: contractorId, non-blank reference and description
    if (!current.contractorId) {
      throw new PlanningEnvelopeError(422, "REVISION_VALIDATION_FAILED", "contractorId is required for review");
    }
    if (!current.reference || current.reference.trim().length === 0) {
      throw new PlanningEnvelopeError(422, "REVISION_VALIDATION_FAILED", "reference is required for review");
    }
    if (!current.descriptionFr || current.descriptionFr.trim().length === 0) {
      throw new PlanningEnvelopeError(422, "REVISION_VALIDATION_FAILED", "descriptionFr is required for review");
    }

    // Validate amounts: must be present and positive, ttc >= ht
    if (!current.amountHt || !current.amountTtc) {
      throw new PlanningEnvelopeError(422, "REVISION_VALIDATION_FAILED", "amountHt and amountTtc are required for review");
    }
    validatePositiveAmounts({ amountHt: current.amountHt, amountTtc: current.amountTtc });

    // Validate cross-project lot (belt-and-suspenders)
    await validateContractorForProject(current.contractorId, input.projectId, tx, {
      allowOrphaned: true,
    });
    await validateLotForProject(current.lotId, input.projectId, tx);
    await validateTechnicalLotForSelection(current.archidocTechnicalLotId, tx, {
      allowInactiveId: current.archidocTechnicalLotId,
    });

    // Check source requirements (verification gate for PDF with low confidence / blocking warnings)
    const [source] = await tx
      .select()
      .from(planningRevisionSources)
      .where(eq(planningRevisionSources.revisionId, input.revisionId));

    if (source?.requiresVerification) {
      const note = (input.verificationNote ?? "").trim();
      if (note.length < 10) {
        throw new PlanningEnvelopeError(
          422,
          "REVISION_SOURCE_VERIFICATION_REQUIRED",
          "A non-trivial verification note is required for PDF revisions with low confidence or warnings",
        );
      }
      // Stamp verification
      await tx
        .update(planningRevisionSources)
        .set({ verifiedAt: new Date(), verifiedBy: input.actor, verificationNote: note })
        .where(eq(planningRevisionSources.revisionId, input.revisionId));
    }

    // Validate line totals are non-negative (nonnegative quantities/prices enforced by DB but check early)
    const lines = await tx
      .select()
      .from(planningRevisionLines)
      .where(eq(planningRevisionLines.revisionId, input.revisionId));

    for (const line of lines) {
      if (!line.description || line.description.trim().length === 0) {
        throw new PlanningEnvelopeError(422, "REVISION_VALIDATION_FAILED", `Line ${line.lineNumber} missing description`);
      }
      const totalHt = Number(line.totalHt);
      if (!Number.isFinite(totalHt) || totalHt < 0) {
        throw new PlanningEnvelopeError(422, "REVISION_VALIDATION_FAILED", `Line ${line.lineNumber} has invalid or negative totalHt`);
      }
      if (line.unitPriceHt !== null) {
        const up = Number(line.unitPriceHt);
        if (!Number.isFinite(up) || up < 0) {
          throw new PlanningEnvelopeError(422, "REVISION_VALIDATION_FAILED", `Line ${line.lineNumber} has invalid or negative unitPriceHt`);
        }
      }
      if (line.quantity !== null) {
        const qty = Number(line.quantity);
        if (!Number.isFinite(qty) || qty < 0) {
          throw new PlanningEnvelopeError(422, "REVISION_VALIDATION_FAILED", `Line ${line.lineNumber} has invalid or negative quantity`);
        }
      }
    }

    if (lines.length > 0) {
      const headerHt = roundCurrency(Number(current.amountHt));
      const linesHt = roundCurrency(lines.reduce((sum, line) => sum + Number(line.totalHt), 0));
      if (headerHt !== linesHt) {
        throw new PlanningEnvelopeError(
          422,
          "REVISION_VALIDATION_FAILED",
          "Line totals must equal amountHt before review",
          {
            amountHt: headerHt.toFixed(2),
            lineTotalHt: linesHt.toFixed(2),
          },
        );
      }
    }

    await tx
      .update(planningRevisions)
      .set({
        status: "reviewed",
        reviewedBy: input.actor,
        reviewedAt: new Date(),
        version: current.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(planningRevisions.id, input.revisionId));

    await appendEvent(tx, input.revisionId, "reviewed", input.actor, {
      verificationApplied: source?.requiresVerification ?? false,
    });

    return (await getRevisionDetailWith(input.revisionId, tx))!;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Approve (reviewed → approved)
// ─────────────────────────────────────────────────────────────────────────────

export interface ApproveRevisionInput {
  revisionId: number;
  projectId: number;
  actor: string;
  expectedVersion: number;
}

export async function approveRevision(input: ApproveRevisionInput): Promise<RevisionDetail> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(planningRevisions)
      .where(eq(planningRevisions.id, input.revisionId))
      .for("update");

    if (!current) {
      throw new PlanningEnvelopeError(404, "REVISION_NOT_FOUND", "Revision not found");
    }

    const [envelope] = await tx
      .select()
      .from(planningEnvelopes)
      .where(eq(planningEnvelopes.id, current.envelopeId));
    if (!envelope || envelope.projectId !== input.projectId) {
      throw new PlanningEnvelopeError(403, "REVISION_WRONG_PROJECT", "Revision does not belong to this project");
    }
    await assertProjectMutable(input.projectId, tx);

    if (current.status !== "reviewed") {
      throw new PlanningEnvelopeError(
        409,
        "REVISION_STATUS_CONFLICT",
        `Only reviewed revisions can be approved (current: ${current.status})`,
      );
    }

    if (current.version !== input.expectedVersion) {
      throw new PlanningEnvelopeError(
        409,
        "REVISION_CAS_CONFLICT",
        `Version conflict: expected ${input.expectedVersion}, got ${current.version}`,
        { expectedVersion: input.expectedVersion, currentVersion: current.version },
      );
    }

    let supersededParent: PlanningRevision | null = null;
    if (current.supersedesRevisionId) {
      const [parent] = await tx
        .select()
        .from(planningRevisions)
        .where(eq(planningRevisions.id, current.supersedesRevisionId))
        .for("update");
      if (!parent || parent.envelopeId !== current.envelopeId) {
        throw new PlanningEnvelopeError(
          422,
          "REVISION_SUPERSEDES_MISMATCH",
          "The superseded revision no longer belongs to this envelope",
        );
      }
      if (parent.status !== "approved") {
        throw new PlanningEnvelopeError(
          409,
          "REVISION_STATUS_CONFLICT",
          "The superseded revision is no longer the approved predecessor",
          { supersedesRevisionId: parent.id, currentStatus: parent.status },
        );
      }
      supersededParent = parent;
    }

    const lines = await tx
      .select()
      .from(planningRevisionLines)
      .where(eq(planningRevisionLines.revisionId, input.revisionId))
      .orderBy(planningRevisionLines.lineNumber);

    const [source] = await tx
      .select()
      .from(planningRevisionSources)
      .where(eq(planningRevisionSources.revisionId, input.revisionId));

    // Freeze canonical snapshot (stableStringify → deterministic SHA256 unaffected by JSONB key reordering)
    const snapshot = buildApprovedSnapshot(current, lines, source ?? null);
    const snapshotJson = stableStringify(snapshot);
    const snapshotHash = sha256(snapshotJson);

    await tx
      .update(planningRevisions)
      .set({
        status: "approved",
        approvedBy: input.actor,
        approvedAt: new Date(),
        approvedSnapshot: snapshot,
        approvedSnapshotSha256: snapshotHash,
        version: current.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(planningRevisions.id, input.revisionId));

    // Supersede the revision that this one supersedes
    if (supersededParent) {
      await tx
        .update(planningRevisions)
        .set({
          status: "superseded",
          supersededBy: input.actor,
          supersededAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(planningRevisions.id, supersededParent.id));
      await appendEvent(tx, supersededParent.id, "superseded", input.actor, {
        supersededByRevisionId: input.revisionId,
      });
    }

    await appendEvent(tx, input.revisionId, "approved", input.actor, {
      snapshotSha256: snapshotHash,
    });

    return (await getRevisionDetailWith(input.revisionId, tx))!;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Revise (clone approved → new linked draft)
// ─────────────────────────────────────────────────────────────────────────────

export interface ReviseRevisionInput {
  revisionId: number;
  projectId: number;
  actor: string;
}

export async function reviseRevision(input: ReviseRevisionInput): Promise<RevisionDetail> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(planningRevisions)
      .where(eq(planningRevisions.id, input.revisionId));

    if (!current) {
      throw new PlanningEnvelopeError(404, "REVISION_NOT_FOUND", "Revision not found");
    }

    const [envelope] = await tx
      .select()
      .from(planningEnvelopes)
      .where(eq(planningEnvelopes.id, current.envelopeId));
    if (!envelope || envelope.projectId !== input.projectId) {
      throw new PlanningEnvelopeError(403, "REVISION_WRONG_PROJECT", "Revision does not belong to this project");
    }
    await assertProjectMutable(input.projectId, tx);

    if (current.status !== "approved") {
      throw new PlanningEnvelopeError(
        409,
        "REVISION_STATUS_CONFLICT",
        `Can only revise approved revisions (current: ${current.status})`,
      );
    }

    const oldLines = await tx
      .select()
      .from(planningRevisionLines)
      .where(eq(planningRevisionLines.revisionId, input.revisionId))
      .orderBy(planningRevisionLines.lineNumber);

    // Create new draft revision linked to the source
    const [newRevision] = await tx
      .insert(planningRevisions)
      .values({
        envelopeId: current.envelopeId,
        version: 1,
        status: "draft",
        contractorId: current.contractorId,
        lotId: current.lotId,
        archidocTechnicalLotId: current.archidocTechnicalLotId,
        reference: current.reference,
        descriptionFr: current.descriptionFr,
        documentDate: current.documentDate,
        amountHt: current.amountHt,
        amountTtc: current.amountTtc,
        tvaRatePercent: current.tvaRatePercent,
        tvaAutoliquidation: current.tvaAutoliquidation,
        supersedesRevisionId: input.revisionId,
        createdBy: input.actor,
      })
      .returning();

    // Copy lines
    if (oldLines.length > 0) {
      await tx.insert(planningRevisionLines).values(
        oldLines.map((l) => ({
          revisionId: newRevision.id,
          lineNumber: l.lineNumber,
          description: l.description,
          quantity: l.quantity,
          unit: l.unit,
          unitPriceHt: l.unitPriceHt,
          totalHt: l.totalHt,
          pdfPageHint: l.pdfPageHint,
          pdfBbox: l.pdfBbox,
        })),
      );
    }

    // Manual source for the new revision
    await tx.insert(planningRevisionSources).values({
      revisionId: newRevision.id,
      sourceKind: "manual",
      requiresVerification: false,
    });

    await appendEvent(tx, newRevision.id, "created", input.actor, {
      clonedFromRevisionId: input.revisionId,
      sourceKind: "manual",
    });

    return (await getRevisionDetailWith(newRevision.id, tx))!;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Promote (approved → live devis)
// ─────────────────────────────────────────────────────────────────────────────

export interface PromoteRevisionInput {
  revisionId: number;
  projectId: number;
  actor: string;
  expectedVersion: number;
}

export interface PromoteRevisionResult {
  devisId: number;
  replay: boolean;
}

export async function promoteRevision(input: PromoteRevisionInput): Promise<PromoteRevisionResult> {
  return db.transaction(async (tx) => {
    // Row-lock the revision
    const [current] = await tx
      .select()
      .from(planningRevisions)
      .where(eq(planningRevisions.id, input.revisionId))
      .for("update");

    if (!current) {
      throw new PlanningEnvelopeError(404, "REVISION_NOT_FOUND", "Revision not found");
    }

    const [envelope] = await tx
      .select()
      .from(planningEnvelopes)
      .where(eq(planningEnvelopes.id, current.envelopeId));
    if (!envelope || envelope.projectId !== input.projectId) {
      throw new PlanningEnvelopeError(403, "REVISION_WRONG_PROJECT", "Revision does not belong to this project");
    }
    // ── Idempotency: return early BEFORE any version/status checks ────────────
    // After project/revision lookup, if already promoted, return replay regardless
    // of current status or version (the row-lock prevents double-fire).
    if (current.promotedDevisId) {
      const [promoted] = await tx
        .select({
          id: devis.id,
          projectId: devis.projectId,
          sourcePlanningRevisionId: devis.sourcePlanningRevisionId,
        })
        .from(devis)
        .where(eq(devis.id, current.promotedDevisId));
      if (
        !promoted ||
        promoted.projectId !== input.projectId ||
        promoted.sourcePlanningRevisionId !== current.id
      ) {
        throw new PlanningEnvelopeError(
          409,
          "REVISION_SNAPSHOT_IDENTITY_MISMATCH",
          "Existing promotion provenance does not match this planning revision",
        );
      }
      return { devisId: current.promotedDevisId, replay: true };
    }

    // ── First-time promotion: enforce approved status + CAS ───────────────────
    await assertProjectMutable(input.projectId, tx);

    if (current.status !== "approved") {
      throw new PlanningEnvelopeError(
        409,
        "REVISION_NOT_APPROVED",
        `Only approved revisions can be promoted (current: ${current.status})`,
      );
    }

    if (current.version !== input.expectedVersion) {
      throw new PlanningEnvelopeError(
        409,
        "REVISION_CAS_CONFLICT",
        `Version conflict: expected ${input.expectedVersion}, got ${current.version}`,
        { expectedVersion: input.expectedVersion, currentVersion: current.version },
      );
    }

    // ── Parse and validate the stored approved snapshot ───────────────────────
    if (!current.approvedSnapshot || !current.approvedSnapshotSha256) {
      throw new PlanningEnvelopeError(
        409,
        "REVISION_SNAPSHOT_HASH_MISMATCH",
        "Approved snapshot is missing — revision cannot be promoted",
      );
    }

    if (!isApprovedSnapshot(current.approvedSnapshot)) {
      throw new PlanningEnvelopeError(
        409,
        "REVISION_SNAPSHOT_HASH_MISMATCH",
        "Approved snapshot has unexpected shape — revision cannot be promoted",
      );
    }

    const snap: ApprovedSnapshot = current.approvedSnapshot as unknown as ApprovedSnapshot;

    // Verify snapshot identity: revisionId and envelopeId must match current row
    if (snap.revisionId !== current.id || snap.envelopeId !== current.envelopeId) {
      throw new PlanningEnvelopeError(
        409,
        "REVISION_SNAPSHOT_IDENTITY_MISMATCH",
        "Approved snapshot identity mismatch — revision/envelope IDs do not match",
        { snapRevisionId: snap.revisionId, currentId: current.id },
      );
    }

    // Verify snapshot hash (stableStringify is JSONB-round-trip stable)
    const computedHash = sha256(stableStringify(snap as unknown));
    if (computedHash !== current.approvedSnapshotSha256) {
      throw new PlanningEnvelopeError(
        409,
        "REVISION_SNAPSHOT_HASH_MISMATCH",
        "Approved snapshot hash mismatch — revision may have been tampered with",
        { expected: current.approvedSnapshotSha256, computed: computedHash },
      );
    }

    // Verify the complete immutable source provenance matches the approved snapshot.
    const [currentSource] = await tx
      .select()
      .from(planningRevisionSources)
      .where(eq(planningRevisionSources.revisionId, input.revisionId));

    const snapSource = snap.source;
    const liveSource = buildApprovedSnapshotSource(currentSource ?? null);

    if (stableStringify(snapSource) !== stableStringify(liveSource)) {
      throw new PlanningEnvelopeError(
        409,
        "REVISION_SNAPSHOT_IDENTITY_MISMATCH",
        "Source provenance mismatch between snapshot and live source record",
      );
    }

    // ── Revalidate snapshot contractor and lot–project relationship ───────────
    if (!snap.contractorId) {
      throw new PlanningEnvelopeError(422, "REVISION_VALIDATION_FAILED", "contractorId is required for promotion");
    }
    const [ctr] = await tx.select({ id: contractors.id }).from(contractors).where(eq(contractors.id, snap.contractorId));
    if (!ctr) {
      throw new PlanningEnvelopeError(404, "CONTRACTOR_NOT_FOUND", `Contractor ${snap.contractorId} not found`);
    }

    if (snap.lotId) {
      const [lotRow] = await tx.select({ id: lots.id, projectId: lots.projectId }).from(lots).where(eq(lots.id, snap.lotId));
      if (!lotRow) {
        throw new PlanningEnvelopeError(404, "LOT_NOT_FOUND", `Lot ${snap.lotId} not found`);
      }
      if (lotRow.projectId !== input.projectId) {
        throw new PlanningEnvelopeError(
          422,
          "REVISION_CROSS_PROJECT_LOT",
          `Lot ${snap.lotId} belongs to a different project`,
        );
      }
    }

    // ── Create the devis from the SNAPSHOT (never from mutable live fields) ───
    const amountHt = snap.amountHt ?? "0.00";
    const amountTtc = snap.amountTtc ?? "0.00";
    const description = snap.descriptionFr ?? snap.reference ?? "Devis from planning revision";

    const [newDevis] = await tx
      .insert(devis)
      .values({
        projectId: input.projectId,
        contractorId: snap.contractorId,
        lotId: snap.lotId,
        marcheId: null,
        devisCode: snap.reference ?? `PLAN-${input.revisionId}`,
        devisNumber: snap.reference ?? null,
        descriptionFr: description,
        amountHt,
        amountTtc,
        status: "draft",
        accountingState: "provisional",
        signOffStage: "received",
        pdfStorageKey: snap.source?.storageKey ?? null,
        pdfFileName: snap.source?.fileName ?? null,
        aiExtractedData: snap.source?.rawExtraction ?? null,
        aiConfidence: snap.source?.confidence ?? null,
        validationWarnings: snap.source?.warnings ?? null,
        // Attached only after every frozen line has been inserted. The DB
        // validates the complete candidate and defers reciprocal-link checking
        // until this transaction also stamps planning_revisions.promoted_devis_id.
        sourcePlanningRevisionId: null,
      })
      .returning();

    // Create devis line items from SNAPSHOT lines (not from live planningRevisionLines)
    if (snap.lines.length > 0) {
      await tx.insert(devisLineItems).values(
        snap.lines.map((l, idx) => ({
          devisId: newDevis.id,
          lineNumber: l.lineNumber ?? idx + 1,
          description: l.description,
          quantity: l.quantity,
          unit: l.unit,
          unitPriceHt: l.unitPriceHt,
          totalHt: l.totalHt,
          pdfPageHint: l.pdfPageHint,
          pdfBbox: l.pdfBbox,
        })),
      );
    }

    await tx
      .update(devis)
      .set({ sourcePlanningRevisionId: input.revisionId })
      .where(eq(devis.id, newDevis.id));

    // Stamp promotion on the revision
    await tx
      .update(planningRevisions)
      .set({
        promotedDevisId: newDevis.id,
        promotedBy: input.actor,
        promotedAt: new Date(),
        version: current.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(planningRevisions.id, input.revisionId));

    await appendEvent(tx, input.revisionId, "promoted", input.actor, {
      devisId: newDevis.id,
    });

    return { devisId: newDevis.id, replay: false };
  });
}
