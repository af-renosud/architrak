import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  archidocPaymentSupplierAssignments,
  archidocPaymentSuppliers,
  projects,
  supplierDirectPaymentQuotations,
} from "@shared/schema";
import { db } from "../db";

export const MAX_SUPPLIER_QUOTATION_PDF_BYTES = 25 * 1024 * 1024;

export type PaymentSupplierCandidate = {
  paymentSupplierId: string;
  name: string;
  siret: string | null;
  assignedArchidocProjectIds: string[];
  isDeleted: boolean;
  isActive?: boolean;
};

export type SupplierQuotationEvidence = {
  paymentSupplierId?: string | null;
  name?: string | null;
  siret?: string | null;
  archidocProjectId: string;
};

export type SupplierMatch =
  | { status: "matched"; paymentSupplierId: string; evidence: "opaque_id" | "assignment_siret" }
  | { status: "review_required"; reason: "not_found" | "ambiguous" | "weak_name_only" | "cross_project" | "invalid_siret" };

export class SupplierQuotationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = "SupplierQuotationError";
  }
}

export function normalizeSupplierName(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, " ").trim();
}

export function normalizeSupplierSiret(value: string): string {
  return value.replace(/\D/g, "");
}

export function matchPaymentSupplier(
  evidence: SupplierQuotationEvidence,
  suppliers: PaymentSupplierCandidate[],
): SupplierMatch {
  const live = suppliers.filter(supplier => !supplier.isDeleted && supplier.isActive !== false);
  if (evidence.paymentSupplierId) {
    const supplier = live.find(candidate => candidate.paymentSupplierId === evidence.paymentSupplierId);
    if (!supplier) return { status: "review_required", reason: "not_found" };
    if (!supplier.assignedArchidocProjectIds.includes(evidence.archidocProjectId)) {
      return { status: "review_required", reason: "cross_project" };
    }
    return { status: "matched", paymentSupplierId: supplier.paymentSupplierId, evidence: "opaque_id" };
  }

  const assigned = live.filter(supplier =>
    supplier.assignedArchidocProjectIds.includes(evidence.archidocProjectId));
  const suppliedSiret = evidence.siret?.trim() ?? "";
  const siret = normalizeSupplierSiret(suppliedSiret);
  if (suppliedSiret && siret.length !== 14) {
    return { status: "review_required", reason: "invalid_siret" };
  }
  if (siret.length === 14) {
    const candidates = assigned.filter(supplier => supplier.siret === siret);
    if (candidates.length === 1) {
      return { status: "matched", paymentSupplierId: candidates[0].paymentSupplierId, evidence: "assignment_siret" };
    }
    return { status: "review_required", reason: candidates.length ? "ambiguous" : "not_found" };
  }
  // Names are display/search evidence only and never auto-appoint a supplier.
  if (evidence.name?.trim()) return { status: "review_required", reason: "weak_name_only" };
  return { status: "review_required", reason: "not_found" };
}

export type SupplierQuotationRecord = typeof supplierDirectPaymentQuotations.$inferSelect;

export type SupplierQuotationInsert = {
  projectId: number;
  archidocProjectId: string;
  sourceDocumentId: string;
  sourceSha256: string;
  fileName: string;
  sourcePdf: Buffer;
  extractedPaymentSupplierId: string | null;
  extractedSupplierName: string | null;
  extractedSupplierSiret: string | null;
  matchStatus: "matched" | "review_required";
  matchReason: string | null;
  matchEvidence: Record<string, unknown>;
};

export interface SupplierQuotationRepository {
  getProject(projectId: number): Promise<{ id: number; archidocId: string | null } | undefined>;
  listCandidates(): Promise<PaymentSupplierCandidate[]>;
  insertIdempotent(input: SupplierQuotationInsert): Promise<SupplierQuotationRecord>;
  getQuotation(id: number): Promise<SupplierQuotationRecord | undefined>;
  confirmAppointment(id: number, paymentSupplierId: string, userId: number): Promise<SupplierQuotationRecord>;
}

export type IngestSupplierQuotationInput = {
  projectId: number;
  archidocProjectId: string;
  sourceDocumentId: string;
  fileName: string;
  pdf: Buffer;
  extractedPaymentSupplierId?: string | null;
  extractedSupplierName?: string | null;
  extractedSupplierSiret?: string | null;
};

function required(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new SupplierQuotationError("invalid_metadata", `${field} is required`);
  return normalized;
}

export async function ingestSupplierQuotation(
  repository: SupplierQuotationRepository,
  input: IngestSupplierQuotationInput,
): Promise<SupplierQuotationRecord> {
  if (!Number.isInteger(input.projectId) || input.projectId <= 0) {
    throw new SupplierQuotationError("invalid_project", "projectId must be a positive integer");
  }
  if (!Buffer.isBuffer(input.pdf) || input.pdf.length < 4 ||
      !input.pdf.subarray(0, 4).equals(Buffer.from("%PDF"))) {
    throw new SupplierQuotationError("not_pdf", "Uploaded file must begin with %PDF", 415);
  }
  if (input.pdf.length > MAX_SUPPLIER_QUOTATION_PDF_BYTES) {
    throw new SupplierQuotationError("pdf_too_large", "Uploaded PDF exceeds the 25 MiB limit", 413);
  }

  const archidocProjectId = required(input.archidocProjectId, "archidocProjectId");
  const project = await repository.getProject(input.projectId);
  if (!project) throw new SupplierQuotationError("project_not_found", "Project not found", 404);
  if (!project.archidocId || project.archidocId !== archidocProjectId) {
    throw new SupplierQuotationError(
      "cross_project",
      "ArchiDoc project does not match the local project",
      409,
    );
  }

  const paymentSupplierId = input.extractedPaymentSupplierId?.trim() || null;
  const name = input.extractedSupplierName?.trim() || null;
  const rawSiret = input.extractedSupplierSiret?.trim() || null;
  const normalizedSiret = rawSiret ? normalizeSupplierSiret(rawSiret) : null;
  const storedSiret = normalizedSiret?.length === 14 ? normalizedSiret : null;
  const evidence: SupplierQuotationEvidence = {
    archidocProjectId,
    paymentSupplierId,
    name,
    siret: rawSiret,
  };
  const match = matchPaymentSupplier(evidence, await repository.listCandidates());
  if (match.status === "review_required" && match.reason === "cross_project") {
    throw new SupplierQuotationError(
      "cross_project",
      "Payment supplier is not actively eligible for this ArchiDoc project",
      409,
    );
  }
  const matchEvidence: Record<string, unknown> = {
    normalizedName: name ? normalizeSupplierName(name) : null,
    normalizedSiret,
    matchMethod: match.status === "matched" ? match.evidence : null,
    matchedPaymentSupplierId: match.status === "matched" ? match.paymentSupplierId : null,
  };

  return repository.insertIdempotent({
    projectId: input.projectId,
    archidocProjectId,
    sourceDocumentId: required(input.sourceDocumentId, "sourceDocumentId"),
    sourceSha256: createHash("sha256").update(input.pdf).digest("hex"),
    fileName: required(input.fileName, "fileName"),
    sourcePdf: input.pdf,
    extractedPaymentSupplierId: paymentSupplierId,
    extractedSupplierName: name,
    extractedSupplierSiret: storedSiret,
    matchStatus: match.status,
    matchReason: match.status === "review_required" ? match.reason : null,
    matchEvidence,
  });
}

type DrizzleTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export class DrizzleSupplierQuotationRepository implements SupplierQuotationRepository {
  async getProject(projectId: number) {
    return (await db.select({ id: projects.id, archidocId: projects.archidocId })
      .from(projects).where(eq(projects.id, projectId)).limit(1))[0];
  }

  async listCandidates(): Promise<PaymentSupplierCandidate[]> {
    const today = new Date().toISOString().slice(0, 10);
    const rows = await db.select({
      paymentSupplierId: archidocPaymentSuppliers.paymentSupplierId,
      name: archidocPaymentSuppliers.name,
      siret: archidocPaymentSuppliers.siret,
      isActive: archidocPaymentSuppliers.isActive,
      isDeleted: archidocPaymentSuppliers.isDeleted,
      assignedProjectId: archidocPaymentSupplierAssignments.archidocProjectId,
    }).from(archidocPaymentSuppliers)
      .leftJoin(archidocPaymentSupplierAssignments, and(
        eq(archidocPaymentSupplierAssignments.paymentSupplierId, archidocPaymentSuppliers.paymentSupplierId),
        eq(archidocPaymentSupplierAssignments.isDeleted, false),
        eq(archidocPaymentSupplierAssignments.directPaymentStatus, "eligible"),
        sql`(${archidocPaymentSupplierAssignments.validFrom} IS NULL OR ${archidocPaymentSupplierAssignments.validFrom} <= ${today})`,
        sql`(${archidocPaymentSupplierAssignments.validUntil} IS NULL OR ${archidocPaymentSupplierAssignments.validUntil} >= ${today})`,
      ))
      .where(and(
        eq(archidocPaymentSuppliers.isDeleted, false),
        eq(archidocPaymentSuppliers.isActive, true),
      ));
    const candidates = new Map<string, PaymentSupplierCandidate>();
    for (const row of rows) {
      const candidate = candidates.get(row.paymentSupplierId) ?? {
        paymentSupplierId: row.paymentSupplierId,
        name: row.name,
        siret: row.siret,
        assignedArchidocProjectIds: [],
        isActive: row.isActive,
        isDeleted: row.isDeleted,
      };
      if (row.assignedProjectId && !candidate.assignedArchidocProjectIds.includes(row.assignedProjectId)) {
        candidate.assignedArchidocProjectIds.push(row.assignedProjectId);
      }
      candidates.set(row.paymentSupplierId, candidate);
    }
    return Array.from(candidates.values());
  }

  async insertIdempotent(input: SupplierQuotationInsert): Promise<SupplierQuotationRecord> {
    return db.transaction(async tx => {
      const inserted = await tx.insert(supplierDirectPaymentQuotations).values(input)
        .onConflictDoNothing({
          target: [
            supplierDirectPaymentQuotations.projectId,
            supplierDirectPaymentQuotations.sourceDocumentId,
          ],
        }).returning();
      if (inserted[0]) return inserted[0];
      const existing = (await tx.select().from(supplierDirectPaymentQuotations).where(and(
        eq(supplierDirectPaymentQuotations.projectId, input.projectId),
        eq(supplierDirectPaymentQuotations.sourceDocumentId, input.sourceDocumentId),
      )).limit(1))[0];
      if (!existing) throw new Error("Quotation disappeared after idempotent insert conflict");
      if (existing.sourceSha256 !== input.sourceSha256) {
        throw new SupplierQuotationError(
          "source_document_hash_conflict",
          "The source document ID already exists with different PDF bytes",
          409,
        );
      }
      return existing;
    });
  }

  async getQuotation(id: number): Promise<SupplierQuotationRecord | undefined> {
    return (await db.select().from(supplierDirectPaymentQuotations)
      .where(eq(supplierDirectPaymentQuotations.id, id)).limit(1))[0];
  }

  async confirmAppointment(id: number, paymentSupplierId: string, userId: number): Promise<SupplierQuotationRecord> {
    return db.transaction(tx => this.confirmInTransaction(tx, id, paymentSupplierId, userId));
  }

  private async confirmInTransaction(
    tx: DrizzleTransaction,
    id: number,
    paymentSupplierId: string,
    userId: number,
  ): Promise<SupplierQuotationRecord> {
    const quotation = (await tx.select().from(supplierDirectPaymentQuotations)
      .where(eq(supplierDirectPaymentQuotations.id, id)).for("update").limit(1))[0];
    if (!quotation) throw new SupplierQuotationError("quotation_not_found", "Supplier quotation not found", 404);
    if (quotation.appointedPaymentSupplierId) {
      if (quotation.appointedPaymentSupplierId === paymentSupplierId) return quotation;
      throw new SupplierQuotationError(
        "appointment_conflict",
        "Quotation is already appointed to a different payment supplier",
        409,
      );
    }

    const supplier = (await tx.select({ id: archidocPaymentSuppliers.paymentSupplierId })
      .from(archidocPaymentSuppliers).where(and(
        eq(archidocPaymentSuppliers.paymentSupplierId, paymentSupplierId),
        eq(archidocPaymentSuppliers.isDeleted, false),
        eq(archidocPaymentSuppliers.isActive, true),
      )).for("update").limit(1))[0];
    if (!supplier) throw new SupplierQuotationError("supplier_not_found", "Active payment supplier not found", 404);

    const today = new Date().toISOString().slice(0, 10);
    const assignment = (await tx.select({ id: archidocPaymentSupplierAssignments.assignmentId })
      .from(archidocPaymentSupplierAssignments).where(and(
        eq(archidocPaymentSupplierAssignments.paymentSupplierId, paymentSupplierId),
        eq(archidocPaymentSupplierAssignments.archidocProjectId, quotation.archidocProjectId),
        eq(archidocPaymentSupplierAssignments.directPaymentStatus, "eligible"),
        eq(archidocPaymentSupplierAssignments.isDeleted, false),
        sql`(${archidocPaymentSupplierAssignments.validFrom} IS NULL OR ${archidocPaymentSupplierAssignments.validFrom} <= ${today})`,
        sql`(${archidocPaymentSupplierAssignments.validUntil} IS NULL OR ${archidocPaymentSupplierAssignments.validUntil} >= ${today})`,
      )).for("update").limit(1))[0];
    if (!assignment) {
      throw new SupplierQuotationError(
        "supplier_not_eligible",
        "Payment supplier has no active eligible assignment for this project",
        409,
      );
    }
    const now = new Date();
    return (await tx.update(supplierDirectPaymentQuotations).set({
      matchStatus: "appointed",
      matchReason: null,
      appointedPaymentSupplierId: paymentSupplierId,
      appointedAt: now,
      appointedByUserId: userId,
      updatedAt: now,
    }).where(eq(supplierDirectPaymentQuotations.id, id)).returning())[0];
  }
}

export async function confirmPaymentSupplierAppointment(
  repository: SupplierQuotationRepository,
  quotationId: number,
  paymentSupplierId: string,
  userId: number,
): Promise<SupplierQuotationRecord> {
  const normalizedId = paymentSupplierId.trim();
  if (!normalizedId) throw new SupplierQuotationError("invalid_supplier", "paymentSupplierId is required");
  return repository.confirmAppointment(quotationId, normalizedId, userId);
}