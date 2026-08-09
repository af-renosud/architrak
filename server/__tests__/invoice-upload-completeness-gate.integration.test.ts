import { describe, it, expect, vi, beforeEach } from "vitest";

// Task #350 — Integration coverage for the extraction-completeness HARD GATE
// through the REAL invoice upload path. Drives processInvoiceUpload with a
// mocked AI parse whose extractionCoverage proves pages are missing (or that
// a text-evidenced page produced no line items) and asserts the invoice is
// REJECTED with 422 EXTRACTION_INCOMPLETE before any object-storage write or
// createInvoice call — the exact silent-partial-persistence failure class
// from prod DVT0000959.

const { storageSpy, uploadDocumentSpy } = vi.hoisted(() => ({
  storageSpy: {
    getDevis: vi.fn(),
    createProjectDocument: vi.fn(async () => ({ id: 1 })),
    createInvoice: vi.fn(async (row: Record<string, unknown>) => ({
      id: 555,
      invoiceNumber: row.invoiceNumber,
      projectId: row.projectId,
    })),
    revokeDevisCheckTokenIfFullyInvoiced: vi.fn(async () => undefined),
    updateDevis: vi.fn(async () => undefined),
  },
  uploadDocumentSpy: vi.fn(async (_p: number, name: string) => `mock-key/${name}`),
}));

vi.mock("../storage", () => ({ storage: storageSpy }));
vi.mock("../storage/object-storage", () => ({ uploadDocument: uploadDocumentSpy }));
vi.mock("../middleware/upload", () => ({ assertPdfMagic: vi.fn() }));
vi.mock("../services/advisory-reconciler", () => ({
  reconcileAdvisories: vi.fn(async () => undefined),
}));
vi.mock("../services/drive/upload-queue.service", () => ({
  enqueueDriveUpload: vi.fn(async () => undefined),
}));
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
