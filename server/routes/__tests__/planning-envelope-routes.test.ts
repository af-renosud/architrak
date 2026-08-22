/**
 * Task #650 — Planning Envelope route unit tests.
 * Uses mocked storage + service layer; no real DB connection needed.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import express from "express";
import type { AddressInfo } from "net";
import { Readable } from "node:stream";

// ── Mock service layer ──────────────────────────────────────────────────────

vi.mock("../../services/planning-envelope.service", () => ({
  getEnvelopeSummary: vi.fn(),
  getRevisionById: vi.fn(),
  getEnvelopeById: vi.fn(),
  createManualRevision: vi.fn(),
  createPdfRevision: vi.fn(),
  createPlanningImportJob: vi.fn(),
  advancePlanningImportStage: vi.fn(),
  touchPlanningImportJob: vi.fn(),
  failPlanningImportJob: vi.fn(),
  getRecentPlanningImports: vi.fn(),
  patchRevision: vi.fn(),
  reviewRevision: vi.fn(),
  approveRevision: vi.fn(),
  reviseRevision: vi.fn(),
  promoteRevision: vi.fn(),
  PlanningEnvelopeError: class PlanningEnvelopeError extends Error {
    constructor(
      public readonly status: number,
      public readonly code: string,
      message: string,
      public readonly details: Record<string, unknown> = {},
    ) {
      super(message);
      this.name = "PlanningEnvelopeError";
    }
  },
}));

vi.mock("../../gmail/document-parser", () => ({
  parseDocument: vi.fn(),
  matchToProject: vi.fn(),
  isTransientParseFailure: vi.fn(),
  getParseFailureMessage: vi.fn(),
}));

vi.mock("../../storage", async () => {
  const { createStorageMock } = await import("./helpers/mock-storage");
  return {
    storage: createStorageMock(["getProject", "getUser", "getProjects", "getContractors", "getAiModelSetting"]),
  };
});

vi.mock("../../storage/object-storage", () => ({
  uploadDocumentAtKey: vi.fn(),
  getDocumentStream: vi.fn(),
}));

vi.mock("../../auth/middleware", () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const sess = (req as unknown as { session?: { userId?: number } }).session;
    if (!sess?.userId) return _res.status(401).json({ message: "auth required" });
    next();
  },
}));

import { storage } from "../../storage";
import {
  getEnvelopeSummary,
  getRevisionById,
  getEnvelopeById,
  createManualRevision,
  createPlanningImportJob,
  advancePlanningImportStage,
  touchPlanningImportJob,
  failPlanningImportJob,
  getRecentPlanningImports,
  patchRevision,
  reviewRevision,
  approveRevision,
  reviseRevision,
  promoteRevision,
  PlanningEnvelopeError,
} from "../../services/planning-envelope.service";
import {
  parseDocument,
  isTransientParseFailure,
} from "../../gmail/document-parser";
import { getDocumentStream } from "../../storage/object-storage";

const mockGetSummary = getEnvelopeSummary as unknown as ReturnType<typeof vi.fn>;
const mockGetRevisionById = getRevisionById as unknown as ReturnType<typeof vi.fn>;
const mockGetEnvelopeById = getEnvelopeById as unknown as ReturnType<typeof vi.fn>;
const mockCreateManual = createManualRevision as unknown as ReturnType<typeof vi.fn>;
const mockCreateImportJob = createPlanningImportJob as unknown as ReturnType<typeof vi.fn>;
const mockAdvanceImportStage = advancePlanningImportStage as unknown as ReturnType<typeof vi.fn>;
const mockTouchImportJob = touchPlanningImportJob as unknown as ReturnType<typeof vi.fn>;
const mockFailImportJob = failPlanningImportJob as unknown as ReturnType<typeof vi.fn>;
const mockGetRecentImports = getRecentPlanningImports as unknown as ReturnType<typeof vi.fn>;
const mockPatch = patchRevision as unknown as ReturnType<typeof vi.fn>;
const mockReview = reviewRevision as unknown as ReturnType<typeof vi.fn>;
const mockApprove = approveRevision as unknown as ReturnType<typeof vi.fn>;
const mockRevise = reviseRevision as unknown as ReturnType<typeof vi.fn>;
const mockPromote = promoteRevision as unknown as ReturnType<typeof vi.fn>;
const mockParseDocument = parseDocument as unknown as ReturnType<typeof vi.fn>;
const mockIsTransientParseFailure = isTransientParseFailure as unknown as ReturnType<typeof vi.fn>;
const mockGetDocumentStream = getDocumentStream as unknown as ReturnType<typeof vi.fn>;

const mockGetProject = storage.getProject as unknown as ReturnType<typeof vi.fn>;
const mockGetUser = storage.getUser as unknown as ReturnType<typeof vi.fn>;

const FAKE_PROJECT = { id: 1, name: "Test project" };
const FAKE_USER = { id: 42, email: "architect@renosud.com" };
const FAKE_ENVELOPE = { id: 10, projectId: 1, currency: "EUR", createdAt: new Date(), updatedAt: new Date() };
const FAKE_REVISION = {
  id: 5,
  envelopeId: 10,
  version: 1,
  status: "draft",
  amountHt: "1000.00",
  amountTtc: "1200.00",
};
const FAKE_DETAIL = { revision: FAKE_REVISION, lines: [], source: null };

let baseUrl: string;
let server: import("http").Server;

beforeAll(async () => {
  const { default: router } = await import("../planning-envelope");
  const { errorHandler } = await import("../../middleware/error-handler");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const uid = req.header("x-test-user-id");
    (req as unknown as { session: { userId?: number } }).session = uid
      ? { userId: Number(uid) }
      : {};
    next();
  });
  app.use(router);
  app.use(errorHandler);
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
  mockGetSummary.mockReset();
  mockGetRevisionById.mockReset();
  mockGetEnvelopeById.mockReset();
  mockCreateManual.mockReset();
  mockCreateImportJob.mockReset();
  mockAdvanceImportStage.mockReset();
  mockTouchImportJob.mockReset();
  mockFailImportJob.mockReset();
  mockGetRecentImports.mockReset();
  mockPatch.mockReset();
  mockReview.mockReset();
  mockApprove.mockReset();
  mockRevise.mockReset();
  mockPromote.mockReset();
  mockParseDocument.mockReset();
  mockIsTransientParseFailure.mockReset();
  mockGetDocumentStream.mockReset();
  mockGetProject.mockReset();
  mockGetUser.mockReset();
  mockGetUser.mockResolvedValue(FAKE_USER);
  mockGetRecentImports.mockResolvedValue([]);
  mockTouchImportJob.mockResolvedValue(undefined);
  mockAdvanceImportStage.mockResolvedValue(null);
});

// ─────────────────────────────────────────────────────────────────────────────
// Auth guard
// ─────────────────────────────────────────────────────────────────────────────

describe("auth guard", () => {
  it("requires authentication on all planning routes", async () => {
    const routes = [
      ["GET", "/api/projects/1/planning-envelope"],
      ["POST", "/api/projects/1/planning-envelope/revisions"],
      ["GET", "/api/planning-revisions/5"],
      ["GET", "/api/planning-revisions/5/pdf"],
      ["PATCH", "/api/planning-revisions/5"],
    ];
    for (const [method, path] of routes) {
      const res = await fetch(`${baseUrl}${path}`, { method });
      expect(res.status, `${method} ${path} should be 401 without auth`).toBe(401);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/projects/:projectId/planning-envelope
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/projects/:projectId/planning-envelope", () => {
  it("returns 404 when project does not exist", async () => {
    mockGetProject.mockResolvedValue(null);
    const res = await fetch(`${baseUrl}/api/projects/999/planning-envelope`, {
      headers: { "x-test-user-id": "42" },
    });
    expect(res.status).toBe(404);
  });

  it("returns empty summary when no envelope exists", async () => {
    mockGetProject.mockResolvedValue(FAKE_PROJECT);
    mockGetSummary.mockResolvedValue(null);
    const res = await fetch(`${baseUrl}/api/projects/1/planning-envelope`, {
      headers: { "x-test-user-id": "42" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.envelope).toBeNull();
    expect(body.revisions).toEqual([]);
    expect(body.imports).toEqual([]);
    expect(body.totals.amountHt).toBe("0.00");
    expect(body.totals.byLot).toEqual([]);
  });

  it("returns enriched summary with contractorName, lotNumber, and byLot details", async () => {
    mockGetProject.mockResolvedValue(FAKE_PROJECT);
    mockGetSummary.mockResolvedValue({
      envelope: FAKE_ENVELOPE,
      revisions: [{
        ...FAKE_DETAIL,
        contractorName: "Dupont Maçonnerie",
        lotNumber: "02",
      }],
      totals: {
        amountHt: "1000.00",
        amountTtc: "1200.00",
        byLot: [
          { lotId: 7, lotNumber: "02", description: "Gros œuvre", amountHt: "1000.00", amountTtc: "1200.00", count: 1 },
        ],
      },
    });
    const res = await fetch(`${baseUrl}/api/projects/1/planning-envelope`, {
      headers: { "x-test-user-id": "42" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.envelope.id).toBe(10);
    expect(body.totals.amountHt).toBe("1000.00");
    expect(body.revisions[0].contractorName).toBe("Dupont Maçonnerie");
    expect(body.revisions[0].lotNumber).toBe("02");
    expect(body.totals.byLot[0].lotNumber).toBe("02");
    expect(body.totals.byLot[0].description).toBe("Gros œuvre");
    expect(body.totals.byLot[0].count).toBe(1);
    expect(body.totals.byLot[0].amountTtc).toBe("1200.00");
    expect(body.imports).toEqual([]);
  });

  it("returns durable import progress even before an envelope exists", async () => {
    mockGetProject.mockResolvedValue(FAKE_PROJECT);
    mockGetSummary.mockResolvedValue(null);
    mockGetRecentImports.mockResolvedValue([{
      id: 77,
      fileName: "slow-quotation.pdf",
      status: "processing",
      stage: "extracting",
      revisionId: null,
      errorCode: null,
      errorMessage: null,
      startedAt: new Date("2026-08-20T12:00:00Z"),
      updatedAt: new Date("2026-08-20T12:01:00Z"),
      completedAt: null,
    }]);
    const res = await fetch(`${baseUrl}/api/projects/1/planning-envelope`, {
      headers: { "x-test-user-id": "42" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.envelope).toBeNull();
    expect(body.imports).toEqual([
      expect.objectContaining({
        id: 77,
        fileName: "slow-quotation.pdf",
        status: "processing",
        stage: "extracting",
      }),
    ]);
    expect(mockGetRecentImports).toHaveBeenCalledWith(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/projects/:projectId/planning-envelope/import
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/projects/:projectId/planning-envelope/import", () => {
  it("never persists or returns raw parser diagnostics", async () => {
    mockGetProject.mockResolvedValue(FAKE_PROJECT);
    mockCreateImportJob.mockResolvedValue({
      id: 88,
      projectId: 1,
      fileName: "unsafe-provider-error.pdf",
      fileSha256: "a".repeat(64),
      mimeType: "application/pdf",
      fileSizeBytes: 16,
      status: "processing",
      stage: "accepted",
      revisionId: null,
      errorCode: null,
      errorMessage: null,
      createdBy: FAKE_USER.email,
      startedAt: new Date(),
      updatedAt: new Date(),
      completedAt: null,
    });
    mockParseDocument.mockResolvedValue({
      documentType: "unknown",
      rawText: "Parse failed: upstream-secret-diagnostic",
    });
    mockIsTransientParseFailure.mockReturnValue(false);
    mockFailImportJob.mockResolvedValue({
      id: 88,
      status: "failed",
      stage: "validating",
    });

    const form = new FormData();
    form.append(
      "file",
      new Blob(["%PDF-1.4\n%%EOF\n"], { type: "application/pdf" }),
      "unsafe-provider-error.pdf",
    );
    const response = await fetch(`${baseUrl}/api/projects/1/planning-envelope/import`, {
      method: "POST",
      headers: { "x-test-user-id": "42" },
      body: form,
    });
    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body).toEqual({
      message: "Could not extract usable planning data from this PDF. Check the file and try again.",
      code: "DEVIS_PARSE_FAILED",
    });
    expect(JSON.stringify(body)).not.toContain("upstream-secret-diagnostic");
    expect(mockFailImportJob).toHaveBeenCalledWith({
      importJobId: 88,
      errorCode: "DEVIS_PARSE_FAILED",
      errorMessage: "Could not extract usable planning data from this PDF. Check the file and try again.",
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/projects/:projectId/planning-envelope/revisions
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/projects/:projectId/planning-envelope/revisions", () => {
  it("returns 404 when project does not exist", async () => {
    mockGetProject.mockResolvedValue(null);
    const res = await fetch(`${baseUrl}/api/projects/999/planning-envelope/revisions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-test-user-id": "42" },
      body: JSON.stringify({ amountHt: "1000.00", amountTtc: "1200.00" }),
    });
    expect(res.status).toBe(404);
  });

  it("creates a manual draft revision", async () => {
    mockGetProject.mockResolvedValue(FAKE_PROJECT);
    mockCreateManual.mockResolvedValue(FAKE_DETAIL);
    const res = await fetch(`${baseUrl}/api/projects/1/planning-envelope/revisions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-test-user-id": "42" },
      body: JSON.stringify({
        descriptionFr: "Travaux maçonnerie",
        amountHt: "5000.00",
        amountTtc: "6000.00",
      }),
    });
    expect(res.status).toBe(201);
    expect(mockCreateManual).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 1,
        actor: "architect@renosud.com",
        amountHt: "5000.00",
      }),
    );
  });

  it("forwards a bounded ArchiDoc technical-lot ID without coercing it", async () => {
    mockGetProject.mockResolvedValue(FAKE_PROJECT);
    mockCreateManual.mockResolvedValue(FAKE_DETAIL);
    const res = await fetch(`${baseUrl}/api/projects/1/planning-envelope/revisions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-test-user-id": "42" },
      body: JSON.stringify({
        reference: "TECH-LOT",
        descriptionFr: "Technical lot route test",
        amountHt: "5000.00",
        amountTtc: "6000.00",
        archidocTechnicalLotId: "tech-lot-stable-id",
      }),
    });
    expect(res.status).toBe(201);
    expect(mockCreateManual).toHaveBeenCalledWith(
      expect.objectContaining({
        archidocTechnicalLotId: "tech-lot-stable-id",
      }),
    );
  });

  it("rejects an overlong ArchiDoc technical-lot ID", async () => {
    mockGetProject.mockResolvedValue(FAKE_PROJECT);
    const res = await fetch(`${baseUrl}/api/projects/1/planning-envelope/revisions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-test-user-id": "42" },
      body: JSON.stringify({
        archidocTechnicalLotId: "x".repeat(256),
      }),
    });
    expect(res.status).toBe(400);
    expect(mockCreateManual).not.toHaveBeenCalled();
  });

  it("rejects invalid amount format", async () => {
    mockGetProject.mockResolvedValue(FAKE_PROJECT);
    const res = await fetch(`${baseUrl}/api/projects/1/planning-envelope/revisions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-test-user-id": "42" },
      body: JSON.stringify({ amountHt: "not-a-number" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects negative amount", async () => {
    mockGetProject.mockResolvedValue(FAKE_PROJECT);
    const res = await fetch(`${baseUrl}/api/projects/1/planning-envelope/revisions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-test-user-id": "42" },
      body: JSON.stringify({ amountHt: "-500.00", amountTtc: "600.00" }),
    });
    expect(res.status).toBe(400);
  });

  it("includes optional lines in the create call", async () => {
    mockGetProject.mockResolvedValue(FAKE_PROJECT);
    mockCreateManual.mockResolvedValue(FAKE_DETAIL);
    const res = await fetch(`${baseUrl}/api/projects/1/planning-envelope/revisions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-test-user-id": "42" },
      body: JSON.stringify({
        amountHt: "1000.00",
        amountTtc: "1200.00",
        lines: [{ lineNumber: 1, description: "Béton", totalHt: "1000.00" }],
      }),
    });
    expect(res.status).toBe(201);
    expect(mockCreateManual).toHaveBeenCalledWith(
      expect.objectContaining({
        lines: [{ lineNumber: 1, description: "Béton", totalHt: "1000.00" }],
      }),
    );
  });

  it("propagates PlanningEnvelopeError as the right HTTP status", async () => {
    mockGetProject.mockResolvedValue(FAKE_PROJECT);
    mockCreateManual.mockRejectedValue(new PlanningEnvelopeError(
      422, "REVISION_CROSS_PROJECT_LOT", "Lot belongs to different project", {},
    ));
    const res = await fetch(`${baseUrl}/api/projects/1/planning-envelope/revisions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-test-user-id": "42" },
      body: JSON.stringify({ amountHt: "1000.00", amountTtc: "1200.00", lotId: 99 }),
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe("REVISION_CROSS_PROJECT_LOT");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/planning-revisions/:id
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/planning-revisions/:id", () => {
  it("returns 404 for unknown revision", async () => {
    mockGetRevisionById.mockResolvedValue(null);
    const res = await fetch(`${baseUrl}/api/planning-revisions/999`, {
      headers: { "x-test-user-id": "42" },
    });
    expect(res.status).toBe(404);
  });

  it("returns revision detail", async () => {
    mockGetRevisionById.mockResolvedValue(FAKE_DETAIL);
    const res = await fetch(`${baseUrl}/api/planning-revisions/5`, {
      headers: { "x-test-user-id": "42" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.revision.id).toBe(5);
  });
});

describe("GET /api/planning-revisions/:id/pdf", () => {
  const pdfDetail = {
    ...FAKE_DETAIL,
    source: {
      storageKey: "planning/test/source.pdf",
      fileName: "source devis.pdf",
    },
  };

  it("serves the PDF inline for viewing", async () => {
    mockGetRevisionById.mockResolvedValue(pdfDetail);
    mockGetDocumentStream.mockResolvedValue({
      stream: Readable.from(Buffer.from("%PDF-1.4\n%%EOF\n")),
      contentType: "application/pdf",
      size: 15,
    });

    const res = await fetch(`${baseUrl}/api/planning-revisions/5/pdf`, {
      headers: { "x-test-user-id": "42" },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toContain("inline;");
  });

  it("serves the same PDF as an attachment for downloading", async () => {
    mockGetRevisionById.mockResolvedValue(pdfDetail);
    mockGetDocumentStream.mockResolvedValue({
      stream: Readable.from(Buffer.from("%PDF-1.4\n%%EOF\n")),
      contentType: "application/pdf",
      size: 15,
    });

    const res = await fetch(`${baseUrl}/api/planning-revisions/5/pdf?download=1`, {
      headers: { "x-test-user-id": "42" },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("attachment;");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/planning-revisions/:id
// ─────────────────────────────────────────────────────────────────────────────

describe("PATCH /api/planning-revisions/:id", () => {
  it("returns 404 when revision not found", async () => {
    mockGetRevisionById.mockResolvedValue(null);
    const res = await fetch(`${baseUrl}/api/planning-revisions/999`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "x-test-user-id": "42" },
      body: JSON.stringify({ expectedVersion: 1, descriptionFr: "test" }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 409 on CAS conflict", async () => {
    mockGetRevisionById.mockResolvedValue(FAKE_DETAIL);
    mockGetEnvelopeById.mockResolvedValue(FAKE_ENVELOPE);
    mockPatch.mockRejectedValue(new PlanningEnvelopeError(
      409, "REVISION_CAS_CONFLICT", "Version conflict", { expectedVersion: 2, currentVersion: 1 },
    ));
    const res = await fetch(`${baseUrl}/api/planning-revisions/5`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "x-test-user-id": "42" },
      body: JSON.stringify({ expectedVersion: 2, amountHt: "2000.00" }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("REVISION_CAS_CONFLICT");
  });

  it("requires expectedVersion", async () => {
    const res = await fetch(`${baseUrl}/api/planning-revisions/5`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "x-test-user-id": "42" },
      body: JSON.stringify({ amountHt: "2000.00" }),
    });
    expect(res.status).toBe(400);
  });

  it("propagates REVISION_EMPTY_PATCH as 422", async () => {
    mockGetRevisionById.mockResolvedValue(FAKE_DETAIL);
    mockGetEnvelopeById.mockResolvedValue(FAKE_ENVELOPE);
    mockPatch.mockRejectedValue(new PlanningEnvelopeError(
      422, "REVISION_EMPTY_PATCH", "Patch must include at least one editable field",
    ));
    const res = await fetch(`${baseUrl}/api/planning-revisions/5`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "x-test-user-id": "42" },
      body: JSON.stringify({ expectedVersion: 1 }),
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe("REVISION_EMPTY_PATCH");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/planning-revisions/:id/review
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/planning-revisions/:id/review", () => {
  it("requires expectedVersion", async () => {
    const res = await fetch(`${baseUrl}/api/planning-revisions/5/review`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-test-user-id": "42" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("moves draft to reviewed", async () => {
    mockGetRevisionById.mockResolvedValue(FAKE_DETAIL);
    mockGetEnvelopeById.mockResolvedValue(FAKE_ENVELOPE);
    mockReview.mockResolvedValue({
      ...FAKE_DETAIL,
      revision: { ...FAKE_REVISION, status: "reviewed", version: 2 },
    });
    const res = await fetch(`${baseUrl}/api/planning-revisions/5/review`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-test-user-id": "42" },
      body: JSON.stringify({ expectedVersion: 1 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.revision.status).toBe("reviewed");
    expect(mockReview).toHaveBeenCalledWith(
      expect.objectContaining({ revisionId: 5, expectedVersion: 1, actor: "architect@renosud.com" }),
    );
  });

  it("propagates verification gate error as 422", async () => {
    mockGetRevisionById.mockResolvedValue(FAKE_DETAIL);
    mockGetEnvelopeById.mockResolvedValue(FAKE_ENVELOPE);
    mockReview.mockRejectedValue(new PlanningEnvelopeError(
      422, "REVISION_SOURCE_VERIFICATION_REQUIRED", "Verification note required",
    ));
    const res = await fetch(`${baseUrl}/api/planning-revisions/5/review`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-test-user-id": "42" },
      body: JSON.stringify({ expectedVersion: 1 }),
    });
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe("REVISION_SOURCE_VERIFICATION_REQUIRED");
  });

  it("propagates validation failure (missing reference/description) as 422", async () => {
    mockGetRevisionById.mockResolvedValue(FAKE_DETAIL);
    mockGetEnvelopeById.mockResolvedValue(FAKE_ENVELOPE);
    mockReview.mockRejectedValue(new PlanningEnvelopeError(
      422, "REVISION_VALIDATION_FAILED", "reference is required for review",
    ));
    const res = await fetch(`${baseUrl}/api/planning-revisions/5/review`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-test-user-id": "42" },
      body: JSON.stringify({ expectedVersion: 1 }),
    });
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe("REVISION_VALIDATION_FAILED");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/planning-revisions/:id/approve
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/planning-revisions/:id/approve", () => {
  it("moves reviewed to approved and returns snapshot hash", async () => {
    const approvedDetail = {
      ...FAKE_DETAIL,
      revision: {
        ...FAKE_REVISION,
        status: "approved",
        version: 3,
        approvedSnapshotSha256: "abc123",
      },
    };
    mockGetRevisionById.mockResolvedValue(FAKE_DETAIL);
    mockGetEnvelopeById.mockResolvedValue(FAKE_ENVELOPE);
    mockApprove.mockResolvedValue(approvedDetail);
    const res = await fetch(`${baseUrl}/api/planning-revisions/5/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-test-user-id": "42" },
      body: JSON.stringify({ expectedVersion: 2 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.revision.status).toBe("approved");
    expect(body.revision.approvedSnapshotSha256).toBe("abc123");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/planning-revisions/:id/revise
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/planning-revisions/:id/revise", () => {
  it("clones approved revision into new draft", async () => {
    mockGetRevisionById.mockResolvedValue({
      ...FAKE_DETAIL,
      revision: { ...FAKE_REVISION, status: "approved" },
    });
    mockGetEnvelopeById.mockResolvedValue(FAKE_ENVELOPE);
    mockRevise.mockResolvedValue({
      revision: { id: 20, envelopeId: 10, status: "draft", supersedesRevisionId: 5, version: 1 },
      lines: [],
      source: null,
    });
    const res = await fetch(`${baseUrl}/api/planning-revisions/5/revise`, {
      method: "POST",
      headers: { "x-test-user-id": "42" },
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.revision.status).toBe("draft");
    expect(body.revision.supersedesRevisionId).toBe(5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/planning-revisions/:id/promote
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/planning-revisions/:id/promote", () => {
  it("promotes approved revision to a live devis", async () => {
    mockGetRevisionById.mockResolvedValue({
      ...FAKE_DETAIL,
      revision: { ...FAKE_REVISION, status: "approved", version: 3 },
    });
    mockGetEnvelopeById.mockResolvedValue(FAKE_ENVELOPE);
    mockPromote.mockResolvedValue({ devisId: 101, replay: false });
    const res = await fetch(`${baseUrl}/api/planning-revisions/5/promote`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-test-user-id": "42" },
      body: JSON.stringify({ expectedVersion: 3 }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.devisId).toBe(101);
    expect(body.replay).toBe(false);
  });

  it("returns 200 and replay=true for idempotent double promotion", async () => {
    mockGetRevisionById.mockResolvedValue({
      ...FAKE_DETAIL,
      revision: { ...FAKE_REVISION, status: "approved", version: 3, promotedDevisId: 101 },
    });
    mockGetEnvelopeById.mockResolvedValue(FAKE_ENVELOPE);
    mockPromote.mockResolvedValue({ devisId: 101, replay: true });
    const res = await fetch(`${baseUrl}/api/planning-revisions/5/promote`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-test-user-id": "42" },
      body: JSON.stringify({ expectedVersion: 3 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.replay).toBe(true);
    expect(body.devisId).toBe(101);
  });

  it("returns 200 and replay=true for replay with original pre-promote expectedVersion", async () => {
    // Simulate: revision was already promoted (promotedDevisId set) but caller passes the
    // original pre-promotion version (service still returns replay=true since idempotency
    // check happens before CAS check)
    mockGetRevisionById.mockResolvedValue({
      ...FAKE_DETAIL,
      revision: { ...FAKE_REVISION, status: "approved", version: 4, promotedDevisId: 101 },
    });
    mockGetEnvelopeById.mockResolvedValue(FAKE_ENVELOPE);
    mockPromote.mockResolvedValue({ devisId: 101, replay: true });
    const res = await fetch(`${baseUrl}/api/planning-revisions/5/promote`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-test-user-id": "42" },
      body: JSON.stringify({ expectedVersion: 3 }), // original pre-promote version
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.replay).toBe(true);
  });

  it("propagates snapshot hash mismatch as 409", async () => {
    mockGetRevisionById.mockResolvedValue({
      ...FAKE_DETAIL,
      revision: { ...FAKE_REVISION, status: "approved", version: 3 },
    });
    mockGetEnvelopeById.mockResolvedValue(FAKE_ENVELOPE);
    mockPromote.mockRejectedValue(new PlanningEnvelopeError(
      409, "REVISION_SNAPSHOT_HASH_MISMATCH", "Approved snapshot hash mismatch",
    ));
    const res = await fetch(`${baseUrl}/api/planning-revisions/5/promote`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-test-user-id": "42" },
      body: JSON.stringify({ expectedVersion: 3 }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("REVISION_SNAPSHOT_HASH_MISMATCH");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Zod line schema strictness
// ─────────────────────────────────────────────────────────────────────────────

describe("line schema validation", () => {
  it("accepts a three-decimal quantity when creating a revision", async () => {
    mockGetProject.mockResolvedValue(FAKE_PROJECT);
    mockCreateManual.mockResolvedValue(FAKE_DETAIL);
    const res = await fetch(`${baseUrl}/api/projects/1/planning-envelope/revisions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-test-user-id": "42" },
      body: JSON.stringify({
        amountHt: "1000.00",
        amountTtc: "1200.00",
        lines: [{ lineNumber: 1, description: "Imported line", totalHt: "1000.00", quantity: "1.000" }],
      }),
    });

    expect(res.status).toBe(201);
    expect(mockCreateManual).toHaveBeenCalledWith(expect.objectContaining({
      lines: [expect.objectContaining({ quantity: "1.000" })],
    }));
  });

  it("accepts a database-formatted three-decimal quantity when editing a revision", async () => {
    mockGetRevisionById.mockResolvedValue(FAKE_DETAIL);
    mockGetEnvelopeById.mockResolvedValue(FAKE_ENVELOPE);
    mockPatch.mockResolvedValue(FAKE_DETAIL);
    const res = await fetch(`${baseUrl}/api/planning-revisions/5`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "x-test-user-id": "42" },
      body: JSON.stringify({
        expectedVersion: 1,
        lines: [{ lineNumber: 1, description: "Imported line", totalHt: "1000.00", quantity: "2.000" }],
      }),
    });

    expect(res.status).toBe(200);
    expect(mockPatch).toHaveBeenCalledWith(expect.objectContaining({
      lines: [expect.objectContaining({ quantity: "2.000" })],
    }));
  });

  it("rejects negative totalHt in a line", async () => {
    mockGetProject.mockResolvedValue(FAKE_PROJECT);
    const res = await fetch(`${baseUrl}/api/projects/1/planning-envelope/revisions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-test-user-id": "42" },
      body: JSON.stringify({
        amountHt: "1000.00",
        amountTtc: "1200.00",
        lines: [{ lineNumber: 1, description: "Line", totalHt: "-100.00" }],
      }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects negative unitPriceHt in a line", async () => {
    mockGetProject.mockResolvedValue(FAKE_PROJECT);
    const res = await fetch(`${baseUrl}/api/projects/1/planning-envelope/revisions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-test-user-id": "42" },
      body: JSON.stringify({
        amountHt: "1000.00",
        amountTtc: "1200.00",
        lines: [{ lineNumber: 1, description: "Line", totalHt: "100.00", unitPriceHt: "-10.00" }],
      }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects negative quantity in a line", async () => {
    mockGetProject.mockResolvedValue(FAKE_PROJECT);
    const res = await fetch(`${baseUrl}/api/projects/1/planning-envelope/revisions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-test-user-id": "42" },
      body: JSON.stringify({
        amountHt: "1000.00",
        amountTtc: "1200.00",
        lines: [{ lineNumber: 1, description: "Line", totalHt: "100.00", quantity: "-5.00" }],
      }),
    });
    expect(res.status).toBe(400);
  });

  it.each(["1.0000", "1e3", ".500"])("rejects malformed or over-precision quantity %s", async (quantity) => {
    mockGetProject.mockResolvedValue(FAKE_PROJECT);
    const res = await fetch(`${baseUrl}/api/projects/1/planning-envelope/revisions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-test-user-id": "42" },
      body: JSON.stringify({
        amountHt: "1000.00",
        amountTtc: "1200.00",
        lines: [{ lineNumber: 1, description: "Line", totalHt: "100.00", quantity }],
      }),
    });
    expect(res.status).toBe(400);
  });

  it("keeps monetary values limited to two decimal places", async () => {
    mockGetProject.mockResolvedValue(FAKE_PROJECT);
    const res = await fetch(`${baseUrl}/api/projects/1/planning-envelope/revisions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-test-user-id": "42" },
      body: JSON.stringify({
        amountHt: "1000.00",
        amountTtc: "1200.00",
        lines: [{ lineNumber: 1, description: "Line", totalHt: "100.001", quantity: "1.000" }],
      }),
    });
    expect(res.status).toBe(400);
  });

  it("accepts zero totalHt (non-negative)", async () => {
    mockGetProject.mockResolvedValue(FAKE_PROJECT);
    mockCreateManual.mockResolvedValue(FAKE_DETAIL);
    const res = await fetch(`${baseUrl}/api/projects/1/planning-envelope/revisions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-test-user-id": "42" },
      body: JSON.stringify({
        amountHt: "1000.00",
        amountTtc: "1200.00",
        lines: [{ lineNumber: 1, description: "Free line", totalHt: "0.00" }],
      }),
    });
    expect(res.status).toBe(201);
  });
});
