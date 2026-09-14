import { describe, it, expect, vi, beforeEach } from "vitest";

// Task #350 — Integration coverage for the extraction-completeness HARD GATE
// through the REAL invoice upload path. Drives processInvoiceUpload with a
// mocked AI parse whose extractionCoverage proves pages are missing (or that
// a text-evidenced page produced no line items) and asserts the invoice is
// REJECTED with 422 EXTRACTION_INCOMPLETE before any object-storage write or
// createInvoice call — the exact silent-partial-persistence failure class
// from prod DVT0000959.

const {
  storageSpy,
  uploadDocumentSpy,
  reconcileAdvisoriesSpy,
  enqueueDriveUploadSpy,
  linkAcompteInvoiceTxSpy,
} = vi.hoisted(() => ({
  storageSpy: {
    getDevis: vi.fn(),
    getInvoiceBySourceIntakeDocumentId: vi.fn(),
    createProjectDocument: vi.fn(async () => ({ id: 1 })),
    createIntakeInvoiceWithProjectDocument: vi.fn(),
    createInvoice: vi.fn(async (row: Record<string, unknown>) => ({
      id: 555,
      invoiceNumber: row.invoiceNumber,
      devisId: row.devisId,
      projectId: row.projectId,
      contractorId: row.contractorId,
    })),
    updateInvoice: vi.fn(async () => ({ id: 555 })),
    revokeDevisCheckTokenIfFullyInvoiced: vi.fn(async () => undefined),
    updateDevis: vi.fn(async () => undefined),
  },
  uploadDocumentSpy: vi.fn(async (_p: number, name: string) => `mock-key/${name}`),
  reconcileAdvisoriesSpy: vi.fn(async () => undefined),
  enqueueDriveUploadSpy: vi.fn(async () => undefined),
  linkAcompteInvoiceTxSpy: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../storage", () => ({ storage: storageSpy }));
vi.mock("../storage/object-storage", () => ({ uploadDocument: uploadDocumentSpy }));
vi.mock("../middleware/upload", () => ({ assertPdfMagic: vi.fn() }));
vi.mock("../services/advisory-reconciler", () => ({
  reconcileAdvisories: reconcileAdvisoriesSpy,
}));
vi.mock("../services/drive/upload-queue.service", () => ({
  enqueueDriveUpload: enqueueDriveUploadSpy,
}));
vi.mock("../services/acompte.service", async (importOriginal) => {
  const original = await importOriginal<typeof import("../services/acompte.service")>();
  return { ...original, linkAcompteInvoiceTx: linkAcompteInvoiceTxSpy };
});
vi.mock("../gmail/document-parser", async (importOriginal) => {
  const original = await importOriginal<typeof import("../gmail/document-parser")>();
  return { ...original, parseDocument: vi.fn() };
});

import { processInvoiceUpload } from "../services/invoice-upload.service";
import { parseDocument } from "../gmail/document-parser";
import { INVOICE_UPLOAD_ERROR_CODES } from "../../shared/invoice-upload-errors";

const parseDocumentMock = parseDocument as unknown as ReturnType<typeof vi.fn>;

const DEVIS = {
  id: 7,
  devisCode: "DVP0000661",
  projectId: 3,
  contractorId: 11,
  lotId: null,
  acompteRequired: false,
  acompteState: "not_required",
};

beforeEach(() => {
  vi.clearAllMocks();
  storageSpy.getDevis.mockResolvedValue(DEVIS);
});

const mkFile = () => ({
  buffer: Buffer.from("%PDF-1.4 fake"),
  originalname: "invoice-partial.pdf",
  mimetype: "application/pdf",
});

describe("processInvoiceUpload — completeness hard gate (Task #350)", () => {
  it("rejects with 422 EXTRACTION_INCOMPLETE when rendered pages < pdf page count", async () => {
    parseDocumentMock.mockResolvedValue({
      documentType: "invoice",
      amountHt: 1000,
      amountTtc: 1200,
      extractionCoverage: { pdfPageCount: 7, renderedPageCount: 5, chunkCount: 1 },
      lineItems: [{ description: "1. Item", total: 1000, pageHint: 1 }],
    });
    const result = await processInvoiceUpload(7, mkFile());
    expect(result.success).toBe(false);
    expect(result.status).toBe(422);
    expect(result.data.code).toBe(INVOICE_UPLOAD_ERROR_CODES.EXTRACTION_INCOMPLETE);
    // Nothing persisted, no orphaned PDF in object storage.
    expect(uploadDocumentSpy).not.toHaveBeenCalled();
    expect(storageSpy.createProjectDocument).not.toHaveBeenCalled();
    expect(storageSpy.createInvoice).not.toHaveBeenCalled();
  });

  it("rejects when a text-evidenced page produced no line items (intake preParsed path)", async () => {
    // preParsed simulates the intake/ingest route handing down its parse.
    const preParsed = {
      documentType: "invoice" as const,
      amountHt: 1000,
      amountTtc: 1200,
      extractionCoverage: {
        pdfPageCount: 3,
        renderedPageCount: 3,
        chunkCount: 1,
        pageEvidence: [
          { page: 1, candidateRows: 5, hasTextLayer: true },
          { page: 2, candidateRows: 5, hasTextLayer: true },
          { page: 3, candidateRows: 0, hasTextLayer: true },
        ],
      },
      lineItems: [
        { description: "1. Item", total: 500, pageHint: 1 },
        { description: "2. Item", total: 500, pageHint: 1 },
      ],
    };
    const result = await processInvoiceUpload(7, mkFile(), preParsed);
    expect(result.success).toBe(false);
    expect(result.status).toBe(422);
    expect(result.data.code).toBe(INVOICE_UPLOAD_ERROR_CODES.EXTRACTION_INCOMPLETE);
    expect(String(result.data.message)).toContain("2");
    expect(parseDocumentMock).not.toHaveBeenCalled();
    expect(storageSpy.createInvoice).not.toHaveBeenCalled();
  });

  it("still accepts a complete extraction with full coverage", async () => {
    parseDocumentMock.mockResolvedValue({
      documentType: "invoice",
      amountHt: 1000,
      amountTtc: 1200,
      tvaAmount: 200,
      extractionCoverage: {
        pdfPageCount: 2,
        renderedPageCount: 2,
        chunkCount: 1,
        pageEvidence: [
          { page: 1, candidateRows: 4, hasTextLayer: true },
          { page: 2, candidateRows: 0, hasTextLayer: true },
        ],
      },
      lineItems: [
        { description: "1. Item", total: 500, pageHint: 1 },
        { description: "2. Item", total: 500, pageHint: 1 },
      ],
    });
    const result = await processInvoiceUpload(7, mkFile());
    expect(result.success).toBe(true);
    expect(storageSpy.createInvoice).toHaveBeenCalledOnce();
  });

  it("replays a guarded source-owned invoice without uploading a replacement PDF", async () => {
    const existingInvoice = {
      id: 556,
      sourceIntakeDocumentId: 91,
      devisId: DEVIS.id,
      projectId: DEVIS.projectId,
      contractorId: DEVIS.contractorId,
      invoiceNumber: "FA-REPLAY-1",
      amountHt: "1000",
      tvaAmount: "200",
      amountTtc: "1200",
      status: "draft",
      dateIssued: null,
      datePaid: null,
      pdfPath: "original-source-key/invoice.pdf",
      notes: null,
      validationWarnings: [],
      aiExtractedData: { documentType: "acompte" },
      aiConfidence: 90,
      extractedIban: null,
      extractedBic: null,
    };
    storageSpy.getInvoiceBySourceIntakeDocumentId.mockResolvedValue(existingInvoice);
    storageSpy.createIntakeInvoiceWithProjectDocument.mockResolvedValue({
      invoice: existingInvoice,
      created: false,
    });

    const result = await processInvoiceUpload(DEVIS.id, mkFile(), {
      documentType: "invoice",
      amountHt: 1000,
      amountTtc: 1200,
      tvaAmount: 200,
      lineItems: [{ description: "1. Item", total: 1000 }],
    }, {
      sourceIntakeDocumentId: 91,
      relationshipGuard: {
        sourceContentFingerprint: "fp-replay-1",
        contractorId: DEVIS.contractorId,
        expectedDevisId: DEVIS.id,
        expectedResolutionKey: "resolved:7:invoice",
        intakeNote: "replay",
      },
    });

    expect(result).toMatchObject({ success: true, status: 200 });
    expect(uploadDocumentSpy).not.toHaveBeenCalled();
    expect(storageSpy.createInvoice).not.toHaveBeenCalled();
    expect(storageSpy.createProjectDocument).not.toHaveBeenCalled();
    expect(reconcileAdvisoriesSpy).toHaveBeenCalledWith(
      { invoiceId: existingInvoice.id },
      existingInvoice.validationWarnings,
      "extractor",
    );
    expect(enqueueDriveUploadSpy).toHaveBeenCalledWith(expect.objectContaining({
      docId: existingInvoice.id,
      sourceStorageKey: existingInvoice.pdfPath,
    }));
    expect(storageSpy.revokeDevisCheckTokenIfFullyInvoiced).toHaveBeenCalledWith(DEVIS.id);
    expect(storageSpy.createIntakeInvoiceWithProjectDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceIntakeDocumentId: 91,
        devisId: DEVIS.id,
        projectId: DEVIS.projectId,
        contractorId: DEVIS.contractorId,
        pdfPath: "original-source-key/invoice.pdf",
      }),
      expect.objectContaining({ storageKey: "original-source-key/invoice.pdf" }),
      expect.any(Object),
      { routeSource: true },
    );
  });

  it("keeps a manual upload successful when advisory reconciliation fails after persistence", async () => {
    reconcileAdvisoriesSpy.mockRejectedValueOnce(new Error("advisory database unavailable"));
    const preParsed = {
      documentType: "invoice" as const,
      amountHt: 1000,
      amountTtc: 1200,
      tvaAmount: 200,
      lineItems: [{ description: "1. Item", total: 1000 }],
    };

    const result = await processInvoiceUpload(DEVIS.id, mkFile(), preParsed);

    expect(result).toMatchObject({
      success: true,
      status: 201,
      data: {
        invoice: { id: 555 },
        postPersistenceWarning: {
          code: "invoice_financial_continuation_pending",
          reviewRequired: true,
        },
        validation: { isValid: false },
      },
    });
    expect(storageSpy.createInvoice).toHaveBeenCalledOnce();
    expect(uploadDocumentSpy).toHaveBeenCalledOnce();
    expect(storageSpy.updateInvoice).toHaveBeenCalledWith(555, expect.objectContaining({
      manualIntakeReviewRequired: true,
      validationWarnings: expect.arrayContaining([
        expect.objectContaining({ field: "postPersistence", severity: "error" }),
      ]),
    }));
  });

  it("keeps a manual acompte upload successful when linking needs review after persistence", async () => {
    const pendingAcompteDevis = {
      ...DEVIS,
      acompteRequired: true,
      acompteState: "pending",
    };
    storageSpy.getDevis.mockResolvedValue(pendingAcompteDevis);
    linkAcompteInvoiceTxSpy.mockResolvedValueOnce({
      ok: false,
      code: "acompte_certificat_exists",
      certificatId: 1,
      certificateRef: "AC-EXISTING",
    });
    const preParsed = {
      documentType: "acompte" as const,
      amountHt: 200,
      amountTtc: 240,
      tvaAmount: 40,
      lineItems: [{ description: "Acompte", total: 200 }],
    };

    const result = await processInvoiceUpload(DEVIS.id, mkFile(), preParsed);

    expect(result).toMatchObject({
      success: true,
      status: 201,
      data: {
        invoice: { id: 555 },
        postPersistenceWarning: {
          code: "acompte_certificat_exists",
          reviewRequired: true,
        },
        validation: { isValid: false },
      },
    });
    expect(storageSpy.createInvoice).toHaveBeenCalledOnce();
    expect(linkAcompteInvoiceTxSpy).toHaveBeenCalledWith({
      devisId: DEVIS.id,
      invoiceId: 555,
    });
    expect(uploadDocumentSpy).toHaveBeenCalledOnce();
    expect(storageSpy.updateInvoice).toHaveBeenCalledWith(555, expect.objectContaining({
      manualIntakeReviewRequired: true,
      validationWarnings: expect.arrayContaining([
        expect.objectContaining({ field: "postPersistence", severity: "error" }),
      ]),
    }));
  });

  it("scanned PDFs (no text layer, no hints) are never false-blocked", async () => {
    parseDocumentMock.mockResolvedValue({
      documentType: "invoice",
      amountHt: 1000,
      amountTtc: 1200,
      tvaAmount: 200,
      extractionCoverage: {
        pdfPageCount: 3,
        renderedPageCount: 3,
        chunkCount: 1,
        pageEvidence: [
          { page: 1, candidateRows: 0, hasTextLayer: false },
          { page: 2, candidateRows: 0, hasTextLayer: false },
          { page: 3, candidateRows: 0, hasTextLayer: false },
        ],
      },
      lineItems: [],
    });
    const result = await processInvoiceUpload(7, mkFile());
    expect(result.success).toBe(true);
    expect(storageSpy.createInvoice).toHaveBeenCalledOnce();
  });
});
