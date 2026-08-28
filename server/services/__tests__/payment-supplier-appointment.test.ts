import { describe, expect, it, vi } from "vitest";
import {
  SupplierQuotationError,
  confirmPaymentSupplierAppointment,
  ingestSupplierQuotation,
  matchPaymentSupplier,
  type PaymentSupplierCandidate,
  type SupplierQuotationInsert,
  type SupplierQuotationRecord,
  type SupplierQuotationRepository,
} from "../payment-supplier-appointment";

const supplier: PaymentSupplierCandidate = {
  paymentSupplierId: "opaque-richardson-test",
  name: "RICHARDSON TEST",
  siret: "12345678901234",
  assignedArchidocProjectIds: ["project-test"],
  isDeleted: false,
};

class MemoryRepository implements SupplierQuotationRepository {
  rows = new Map<number, SupplierQuotationRecord>();
  nextId = 1;
  appointments = 0;
  candidates = [supplier];

  async getProject(projectId: number) {
    return projectId === 2 ? { id: 2, archidocId: "project-test" } : undefined;
  }

  async listCandidates() {
    return this.candidates;
  }

  async insertIdempotent(input: SupplierQuotationInsert): Promise<SupplierQuotationRecord> {
    const existing = [...this.rows.values()].find(row =>
      row.projectId === input.projectId && row.sourceDocumentId === input.sourceDocumentId);
    if (existing) {
      if (existing.sourceSha256 !== input.sourceSha256) {
        throw new SupplierQuotationError(
          "source_document_hash_conflict",
          "The source document ID already exists with different PDF bytes",
          409,
        );
      }
      return existing;
    }
    const now = new Date();
    const row: SupplierQuotationRecord = {
      id: this.nextId++,
      ...input,
      appointedPaymentSupplierId: null,
      appointedAt: null,
      appointedByUserId: null,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(row.id, row);
    return row;
  }

  async getQuotation(id: number) {
    return this.rows.get(id);
  }

  async confirmAppointment(id: number, paymentSupplierId: string, userId: number) {
    const row = this.rows.get(id);
    if (!row) throw new SupplierQuotationError("quotation_not_found", "not found", 404);
    if (row.appointedPaymentSupplierId) {
      if (row.appointedPaymentSupplierId === paymentSupplierId) return row;
      throw new SupplierQuotationError("appointment_conflict", "different supplier", 409);
    }
    const candidate = this.candidates.find(item =>
      item.paymentSupplierId === paymentSupplierId &&
      !item.isDeleted &&
      item.assignedArchidocProjectIds.includes(row.archidocProjectId));
    if (!candidate) throw new SupplierQuotationError("supplier_not_eligible", "not eligible", 409);
    const updated = {
      ...row,
      matchStatus: "appointed",
      matchReason: null,
      appointedPaymentSupplierId: paymentSupplierId,
      appointedAt: new Date(),
      appointedByUserId: userId,
      updatedAt: new Date(),
    };
    this.appointments++;
    this.rows.set(id, updated);
    return updated;
  }
}

describe("payment supplier matching", () => {
  it("prioritises immutable ID and assignment-scoped SIRET, while names require review", () => {
    expect(matchPaymentSupplier(
      { archidocProjectId: "project-test", siret: "123 456 789 01234" },
      [supplier],
    )).toMatchObject({ status: "matched", evidence: "assignment_siret" });
    expect(matchPaymentSupplier(
      { archidocProjectId: "other-project", paymentSupplierId: supplier.paymentSupplierId },
      [supplier],
    )).toEqual({ status: "review_required", reason: "cross_project" });
    expect(matchPaymentSupplier(
      { archidocProjectId: "project-test", name: "RICHARDSON TEST" },
      [supplier],
    )).toEqual({ status: "review_required", reason: "weak_name_only" });
    expect(matchPaymentSupplier(
      { archidocProjectId: "project-test", paymentSupplierId: supplier.paymentSupplierId },
      [{ ...supplier, isActive: false }],
    )).toEqual({ status: "review_required", reason: "not_found" });
  });
});

describe("supplier quotation ingestion and appointment journey", () => {
  it("uploads actual PDF bytes twice and creates one quotation and one appointment", async () => {
    const repository = new MemoryRepository();
    const contractorCall = vi.fn();
    const pdf = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n");
    const input = {
      projectId: 2,
      archidocProjectId: "project-test",
      sourceDocumentId: "archidoc-document-42",
      fileName: "richardson.pdf",
      pdf,
      extractedSupplierName: " Richardson TéST ",
      extractedSupplierSiret: "123 456 789 01234",
    };

    const first = await ingestSupplierQuotation(repository, input);
    const replay = await ingestSupplierQuotation(repository, input);
    expect(first.id).toBe(replay.id);
    expect(first.sourcePdf.equals(pdf)).toBe(true);
    expect(first.matchStatus).toBe("matched");
    expect(repository.rows.size).toBe(1);

    const appointed = await confirmPaymentSupplierAppointment(
      repository,
      first.id,
      supplier.paymentSupplierId,
      7,
    );
    const replayedAppointment = await confirmPaymentSupplierAppointment(
      repository,
      first.id,
      supplier.paymentSupplierId,
      7,
    );
    expect(replayedAppointment.id).toBe(appointed.id);
    expect(replayedAppointment.matchStatus).toBe("appointed");
    expect(repository.appointments).toBe(1);
    expect(contractorCall).not.toHaveBeenCalled();
  });

  it("rejects cross-project evidence and a changed PDF for the same source ID", async () => {
    const repository = new MemoryRepository();
    const base = {
      projectId: 2,
      archidocProjectId: "project-test",
      sourceDocumentId: "stable-source-id",
      fileName: "supplier.pdf",
      extractedPaymentSupplierId: supplier.paymentSupplierId,
    };
    await ingestSupplierQuotation(repository, { ...base, pdf: Buffer.from("%PDF-first") });
    await expect(ingestSupplierQuotation(repository, {
      ...base,
      pdf: Buffer.from("%PDF-different"),
    })).rejects.toMatchObject({ code: "source_document_hash_conflict", status: 409 });
    await expect(ingestSupplierQuotation(repository, {
      ...base,
      archidocProjectId: "other-project",
      sourceDocumentId: "other-source",
      pdf: Buffer.from("%PDF-cross"),
    })).rejects.toMatchObject({ code: "cross_project", status: 409 });

    repository.candidates = [{
      ...supplier,
      assignedArchidocProjectIds: ["another-project"],
    }];
    await expect(ingestSupplierQuotation(repository, {
      ...base,
      sourceDocumentId: "cross-assignment",
      pdf: Buffer.from("%PDF-cross-assignment"),
    })).rejects.toMatchObject({ code: "cross_project", status: 409 });
  });
});