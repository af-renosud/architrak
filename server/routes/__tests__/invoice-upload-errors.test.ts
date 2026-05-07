import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import express from "express";
import type { AddressInfo } from "net";

let attachFile = true;

vi.mock("../../middleware/upload", () => ({
  upload: {
    single: () => (req: express.Request, _res: express.Response, next: () => void) => {
      if (attachFile) {
        (req as unknown as { file: unknown }).file = {
          originalname: "test.pdf",
          buffer: Buffer.from("dummy"),
          mimetype: "application/pdf",
        };
      }
      next();
    },
  },
  assertPdfMagic: () => {},
}));

vi.mock("../../auth/middleware", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));

vi.mock("../../storage", () => ({
  storage: {
    getInvoicesByDevis: vi.fn(),
    getInvoice: vi.fn(),
    createInvoice: vi.fn(),
    updateInvoice: vi.fn(),
    deleteInvoice: vi.fn(),
    getInvoicesByProject: vi.fn(),
    revokeDevisCheckTokenIfFullyInvoiced: vi.fn(),
  },
}));

vi.mock("../../services/invoice-upload.service", () => ({
  processInvoiceUpload: vi.fn(),
}));

vi.mock("../../services/invoice-approval.service", () => ({
  approveInvoice: vi.fn(),
}));

vi.mock("../../services/extraction-validator", () => ({
  validateExtraction: vi.fn(),
}));

vi.mock("../../services/advisory-reconciler", () => ({
  reconcileAdvisories: vi.fn(),
  getAdvisoriesForInvoice: vi.fn(),
  acknowledgeAdvisoryForSubject: vi.fn(),
}));

vi.mock("../../storage/object-storage", () => ({
  getDocumentStream: vi.fn(),
}));

import invoiceRouter from "../invoices";
import { processInvoiceUpload } from "../../services/invoice-upload.service";
import { PdfPasswordProtectedError } from "../../gmail/document-parser";
import { INVOICE_UPLOAD_ERROR_CODES } from "../../../shared/invoice-upload-errors";

const processInvoiceUploadMock = processInvoiceUpload as unknown as ReturnType<typeof vi.fn>;

let baseUrl: string;
let server: import("http").Server;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(invoiceRouter);
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ message });
  });
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

beforeEach(() => {
  vi.clearAllMocks();
  attachFile = true;
});

describe("POST /api/devis/:devisId/invoices/upload — stable error codes", () => {
  it("returns 400 NO_FILE_PROVIDED when no file is attached", async () => {
    attachFile = false;
    const res = await fetch(`${baseUrl}/api/devis/1/invoices/upload`, { method: "POST" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe(INVOICE_UPLOAD_ERROR_CODES.NO_FILE_PROVIDED);
    expect(processInvoiceUploadMock).not.toHaveBeenCalled();
  });

  it("returns 422 PDF_PASSWORD_PROTECTED when the parser throws PdfPasswordProtectedError", async () => {
    processInvoiceUploadMock.mockRejectedValue(new PdfPasswordProtectedError());
    const res = await fetch(`${baseUrl}/api/devis/1/invoices/upload`, { method: "POST" });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe(INVOICE_UPLOAD_ERROR_CODES.PDF_PASSWORD_PROTECTED);
  });

  it("returns 415 PDF_INVALID_MAGIC (not collapsed to 500) when assertPdfMagic throws", async () => {
    const err = Object.assign(new Error("Uploaded file is not a valid PDF (magic-byte check failed)"), {
      status: 415,
    });
    processInvoiceUploadMock.mockRejectedValue(err);
    const res = await fetch(`${baseUrl}/api/devis/1/invoices/upload`, { method: "POST" });
    expect(res.status).toBe(415);
    const body = await res.json();
    expect(body.code).toBe(INVOICE_UPLOAD_ERROR_CODES.PDF_INVALID_MAGIC);
  });

  it("returns 404 INVOICE_DEVIS_NOT_FOUND when the service reports the devis is missing", async () => {
    processInvoiceUploadMock.mockResolvedValue({
      success: false,
      status: 404,
      data: { message: "Devis not found", code: INVOICE_UPLOAD_ERROR_CODES.INVOICE_DEVIS_NOT_FOUND },
    });
    const res = await fetch(`${baseUrl}/api/devis/1/invoices/upload`, { method: "POST" });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe(INVOICE_UPLOAD_ERROR_CODES.INVOICE_DEVIS_NOT_FOUND);
  });

  it("returns 500 INVOICE_UPLOAD_FAILED for any unrecognised error", async () => {
    processInvoiceUploadMock.mockRejectedValue(new Error("kaboom"));
    const res = await fetch(`${baseUrl}/api/devis/1/invoices/upload`, { method: "POST" });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe(INVOICE_UPLOAD_ERROR_CODES.INVOICE_UPLOAD_FAILED);
  });
});
