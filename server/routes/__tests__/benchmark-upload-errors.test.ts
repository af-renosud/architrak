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

vi.mock("../../storage", () => ({
  storage: {
    getBenchmarkTags: vi.fn(),
    getBenchmarkDocuments: vi.fn(),
    getBenchmarkDocument: vi.fn(),
    deleteBenchmarkDocument: vi.fn(),
    searchBenchmarkItems: vi.fn(),
    aggregateBenchmarkPrices: vi.fn(),
    setBenchmarkItemTags: vi.fn(),
    getBenchmarkItemTags: vi.fn(),
    deleteBenchmarkItem: vi.fn(),
  },
}));

vi.mock("../../services/benchmark-ingest.service", () => ({
  processStandaloneBenchmarkUpload: vi.fn(),
}));

vi.mock("../../storage/object-storage", () => ({
  getDocumentStream: vi.fn(),
}));

import benchmarksRouter from "../benchmarks";
import { processStandaloneBenchmarkUpload } from "../../services/benchmark-ingest.service";
import { PdfPasswordProtectedError } from "../../gmail/document-parser";
import { BENCHMARK_UPLOAD_ERROR_CODES } from "../../../shared/benchmark-upload-errors";

const processBenchmarkMock = processStandaloneBenchmarkUpload as unknown as ReturnType<typeof vi.fn>;

let baseUrl: string;
let server: import("http").Server;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(benchmarksRouter);
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

async function postUpload(body: Record<string, unknown> = { contractorId: 1 }): Promise<Response> {
  return fetch(`${baseUrl}/api/benchmarks/upload`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/benchmarks/upload — stable error codes", () => {
  it("returns 400 NO_FILE_PROVIDED when no file is attached", async () => {
    attachFile = false;
    const res = await postUpload();
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe(BENCHMARK_UPLOAD_ERROR_CODES.NO_FILE_PROVIDED);
    expect(processBenchmarkMock).not.toHaveBeenCalled();
  });

  it("returns 422 PDF_PASSWORD_PROTECTED when the parser throws PdfPasswordProtectedError", async () => {
    processBenchmarkMock.mockRejectedValue(new PdfPasswordProtectedError());
    const res = await postUpload();
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe(BENCHMARK_UPLOAD_ERROR_CODES.PDF_PASSWORD_PROTECTED);
  });

  it("returns 415 PDF_INVALID_MAGIC (not collapsed to 500) when assertPdfMagic throws", async () => {
    const err = Object.assign(new Error("Uploaded file is not a valid PDF (magic-byte check failed)"), {
      status: 415,
    });
    processBenchmarkMock.mockRejectedValue(err);
    const res = await postUpload();
    expect(res.status).toBe(415);
    const body = await res.json();
    expect(body.code).toBe(BENCHMARK_UPLOAD_ERROR_CODES.PDF_INVALID_MAGIC);
  });

  it("returns 400 BENCHMARK_CONTRACTOR_REQUIRED when the service reports neither contractor nor external name", async () => {
    processBenchmarkMock.mockResolvedValue({
      success: false,
      status: 400,
      data: {
        message: "Either contractorId or externalContractorName must be provided.",
        code: BENCHMARK_UPLOAD_ERROR_CODES.BENCHMARK_CONTRACTOR_REQUIRED,
      },
    });
    const res = await postUpload();
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe(BENCHMARK_UPLOAD_ERROR_CODES.BENCHMARK_CONTRACTOR_REQUIRED);
  });

  it("returns 503 AI_TRANSIENT when extraction transiently fails", async () => {
    processBenchmarkMock.mockResolvedValue({
      success: false,
      status: 503,
      data: {
        message: "AI extraction temporarily unavailable. Please try again in a moment.",
        code: BENCHMARK_UPLOAD_ERROR_CODES.AI_TRANSIENT,
      },
    });
    const res = await postUpload();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe(BENCHMARK_UPLOAD_ERROR_CODES.AI_TRANSIENT);
  });

  it("returns 422 BENCHMARK_PARSE_FAILED when the parser returns nothing useful", async () => {
    processBenchmarkMock.mockResolvedValue({
      success: false,
      status: 422,
      data: {
        message: "Could not extract meaningful data from this PDF.",
        code: BENCHMARK_UPLOAD_ERROR_CODES.BENCHMARK_PARSE_FAILED,
      },
    });
    const res = await postUpload();
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe(BENCHMARK_UPLOAD_ERROR_CODES.BENCHMARK_PARSE_FAILED);
  });

  it("returns 500 BENCHMARK_UPLOAD_FAILED for any unrecognised error", async () => {
    processBenchmarkMock.mockRejectedValue(new Error("kaboom"));
    const res = await postUpload();
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe(BENCHMARK_UPLOAD_ERROR_CODES.BENCHMARK_UPLOAD_FAILED);
  });
});
