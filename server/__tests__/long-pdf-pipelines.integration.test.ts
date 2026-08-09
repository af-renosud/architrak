import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

// Task #352 — Long-PDF regression coverage for the OTHER parseDocument
// callers: the email intake queue, the invoice upload service, and the
// standalone benchmark ingest. Task #350 made parseDocument chunk >5-page
// documents and stamp `extractionCoverage`; these pipelines inherit that
// behavior implicitly. Each test below drives the REAL pipeline with a
// parse produced by the REAL parseDocument (real poppler render + chunk
// merge over the committed 7-page fixture, AI boundary faked via injected
// deps) and asserts:
//   1. full coverage metadata (7 pages / 7 rendered / 2 chunks + page
//      evidence) flows through to the persisted record,
//   2. non-blocking completeness advisories (a line-numbering gap) surface
//      in the persisted/returned warnings,
//   3. the pipeline is NOT hard-gated by those advisories — persistence
//      succeeds.

const { storageSpy, uploadDocumentSpy, txSpies, dbSpy } = vi.hoisted(() => {
  // --- devis rescrape (Task #353) transaction plumbing ---
  // rescrapeDevis runs its mutation inside db.transaction with a tx that
  // executes raw SQL (lock, precondition counts, line delete) plus builder
  // update/insert calls. Dispatch raw SQL by substring; capture builder
  // payloads for assertions.
  const vi_ = vi;
  const txSpies = {
    lockedRow: null as Record<string, unknown> | null,
    updateSet: vi_.fn(),
    insertValues: vi_.fn(),
    execute: vi_.fn(async (q: unknown) => {
      const t = JSON.stringify(q);
      if (t.includes("FOR UPDATE")) return { rows: [] };
      if (t.includes("invoices")) return { rows: [{ count: 0 }] };
      if (t.includes("situation_lines")) return { rows: [{ count: 0 }] };
      if (t.includes("DELETE FROM devis_line_items")) return { rows: [{ id: 1 }], rowCount: 1 };
      return { rows: [] };
    }),
  };
  const tx = {
    execute: txSpies.execute,
    select: () => ({ from: () => ({ where: async () => (txSpies.lockedRow ? [txSpies.lockedRow] : []) }) }),
    update: () => ({
      set: (payload: unknown) => ({
        where: async () => {
          txSpies.updateSet(payload);
        },
      }),
    }),
    insert: () => ({
      values: async (rows: unknown) => {
        txSpies.insertValues(rows);
      },
    }),
  };
  const dbSpy = {
    transaction: vi_.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  const storageSpy = {
    // --- intake queue plumbing ---
    claimIntakeJobForAttempt: vi.fn(),
    markIntakeJobSucceeded: vi.fn(async () => undefined),
    markIntakeJobDeadLettered: vi.fn(async () => undefined),
    markIntakeJobPendingRetry: vi.fn(async () => undefined),
    getProjectIntakeDocument: vi.fn(),
    updateProjectIntakeDocument: vi.fn(async () => undefined),
    findProcessedIntakeDuplicateByFingerprint: vi.fn(async () => null),
    findProcessedIntakeDuplicateByTextHash: vi.fn(async () => null),
    getDevisByProject: vi.fn(async () => []),
    getInvoicesByProject: vi.fn(async () => []),
    getContractors: vi.fn(async () => [{ id: 11, name: "Acme" }]),
    // --- devis upload internals ---
    getProjects: vi.fn(async () => [{ id: 3, name: "Maison Durand" }]),
    createProjectDocument: vi.fn(async () => ({ id: 1 })),
    createDevis: vi.fn(async (row: Record<string, unknown>) => ({
      id: 707,
      projectId: row.projectId,
      lotId: row.lotId ?? null,
      devisCode: row.devisCode,
    })),
    createDevisLineItem: vi.fn(async () => ({ id: 1 })),
    // --- invoice upload internals ---
    getDevis: vi.fn(),
    createInvoice: vi.fn(async (row: Record<string, unknown>) => ({
      id: 555,
      invoiceNumber: row.invoiceNumber,
      projectId: row.projectId,
    })),
    revokeDevisCheckTokenIfFullyInvoiced: vi.fn(async () => undefined),
    updateDevis: vi.fn(async () => undefined),
    // --- benchmark ingest internals ---
    createBenchmarkDocument: vi.fn(async (row: Record<string, unknown>) => ({
      id: 909,
      ...row,
    })),
    getBenchmarkTags: vi.fn(async () => []),
    createBenchmarkItem: vi.fn(async (row: Record<string, unknown>) => ({ id: 1, ...row })),
    setBenchmarkItemTags: vi.fn(async () => undefined),
    // --- devis rescrape internals (Task #353) ---
    getDevisLineContextAssetsByDevis: vi.fn(async () => []),
  };
  return {
    txSpies,
    dbSpy,
    storageSpy,
    uploadDocumentSpy: vi.fn(async (_p: number, name: string) => `mock-key/${name}`),
  };
});

vi.mock("../storage", () => ({ storage: storageSpy }));
vi.mock("../db", () => ({ db: dbSpy }));
vi.mock("../storage/object-storage", () => ({
  getDocumentBuffer: vi.fn(async () => FIXTURE_PDF),
  uploadDocument: uploadDocumentSpy,
}));
vi.mock("../middleware/upload", () => ({ assertPdfMagic: vi.fn() }));
vi.mock("../services/advisory-reconciler", () => ({
  reconcileAdvisories: vi.fn(async () => undefined),
}));
vi.mock("../services/drive/upload-queue.service", () => ({
  enqueueDriveUpload: vi.fn(async () => undefined),
}));
vi.mock("../services/reconciliation/reconciliation-queue.service", () => ({
  enqueueReconciliation: vi.fn(async () => undefined),
}));
vi.mock("../services/devis-translation", () => ({
  triggerDevisTranslation: vi.fn(() => undefined),
}));
vi.mock("../services/lot-reference-validator", () => ({
  checkLotReferencesAgainstCatalog: vi.fn(async () => []),
}));
// Mock ONLY the AI boundary. parseDocument is a vi.fn that each test primes
// with a REAL parse (produced once in beforeAll via the unmocked module);
// validateExtraction / completeness checks / persistence all stay real.
vi.mock("../gmail/document-parser", async (importOriginal) => {
  const original = await importOriginal<typeof import("../gmail/document-parser")>();
  return {
    ...original,
    parseDocument: vi.fn(),
    matchToProject: vi.fn(async () => ({
      projectId: 3,
      contractorId: 11,
      confidence: 90,
      matchedFields: ["contractorName"],
      warnings: [],
    })),
  };
});

import { attemptIntakeJob } from "../services/intake/ingest-queue.service";
import { processInvoiceUpload } from "../services/invoice-upload.service";
import { processStandaloneBenchmarkUpload } from "../services/benchmark-ingest.service";
import { rescrapeDevis } from "../services/devis-rescrape.service";
import { parseDocument, type ParsedDocument } from "../gmail/document-parser";

const parseDocumentMock = parseDocument as unknown as ReturnType<typeof vi.fn>;

const FIXTURE_PDF = readFileSync(join(__dirname, "fixtures", "seven-page-devis.pdf"));

interface WarningShape {
  field: string;
  severity: string;
  message: string;
}

interface CoverageShape {
  pdfPageCount: number;
  renderedPageCount: number;
  chunkCount: number;
  pageEvidence?: Array<{ page: number; candidateRows: number; hasTextLayer: boolean }>;
}

// The REAL merged parse of the 7-page fixture, computed once. The fake
// chunk parser emits one line item per rendered page with within-chunk page
// hints (rebased by mergeChunkedParses) and a deliberate numbering gap
// (…5, 7, 8 — "6" missing) so a NON-blocking completeness advisory exists.
let realParsed: ParsedDocument;

function expectFullCoverage(coverage: CoverageShape | undefined) {
  expect(coverage).toBeDefined();
  expect(coverage!.pdfPageCount).toBe(7);
  expect(coverage!.renderedPageCount).toBe(7);
  expect(coverage!.chunkCount).toBe(2);
  expect(coverage!.pageEvidence).toHaveLength(7);
  const page6 = coverage!.pageEvidence!.find((p) => p.page === 6)!;
  expect(page6.hasTextLayer).toBe(true);
}

function expectAdvisoriesWithoutBlocking(warnings: WarningShape[]) {
  const numbering = warnings.find((w) => w.field === "lineNumbering");
  expect(numbering).toBeDefined();
  expect(numbering!.severity).toBe("warning");
  expect(numbering!.message).toContain("6");
  // No blocking completeness errors: full page coverage + hinted lines on
  // every evidenced page ⇒ pageCoverage/pageLineItems must not fire as errors.
  expect(warnings.find((w) => w.field === "pageCoverage")).toBeUndefined();
  expect(warnings.find((w) => w.field === "pageLineItems" && w.severity === "error")).toBeUndefined();
}

beforeAll(async () => {
  const actual = await vi.importActual<typeof import("../gmail/document-parser")>(
    "../gmail/document-parser",
  );
  let chunkNo = 0;
  const fakeChunkParse = async (images: Buffer[]): Promise<ParsedDocument> => {
    chunkNo++;
    const isFirst = chunkNo === 1;
    // Global line numbers 1..5 for chunk 1 (pages 1–5), then 7..8 for
    // chunk 2 (pages 6–7): a gap at 6 → lineNumbering advisory (warning).
    const base = isFirst ? 0 : 6;
    return {
      documentType: "quotation",
      contractorName: isFirst ? "Acme" : undefined,
      reference: isFirst ? "DEV-2026-777" : undefined,
      amountHt: isFirst ? undefined : 7000,
      amountTtc: isFirst ? undefined : 8400,
      tvaRate: isFirst ? undefined : 20,
      lineItems: images.map((_, i) => ({
        description: `${base + i + 1}. Poste page ${i + 1}`,
        total: 1000,
        quantity: 1,
        unitPrice: 1000,
        pageHint: i + 1,
      })),
    };
  };
  realParsed = await actual.parseDocument(FIXTURE_PDF, "seven-page-devis.pdf", {
    getActiveModel: async () => ({ provider: "gemini", modelId: "test" }),
    parseWithGemini: fakeChunkParse,
    parseWithOpenAI: async () => {
      throw new Error("should not be called");
    },
    hasOpenAIKey: () => false,
  });

  // Sanity: real chunked parse over the fixture produced full coverage and
  // 7 line items with hints rebased to global pages 1..7.
  expect(realParsed.extractionCoverage?.chunkCount).toBe(2);
  expect(realParsed.lineItems).toHaveLength(7);
  expect(realParsed.lineItems![5].pageHint).toBe(6);
  expect(realParsed.lineItems![6].pageHint).toBe(7);
}, 180000);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("email intake queue — long-PDF parse flows coverage into the routed devis (Task #352)", () => {
  it("parseDocument is called by the queue; coverage + advisories persist on intake doc and devis, routing succeeds", async () => {
    const intakeDoc = {
      id: 43,
      projectId: 3,
      fileName: "seven-page-devis.pdf",
      storageKey: "intake/3/seven-page-devis.pdf",
      mimeType: "application/pdf",
      notes: null,
      extractedData: null, // no email pre-parse → queue must call parseDocument
      analysisState: "pending",
      routingState: "pending",
    };
    storageSpy.claimIntakeJobForAttempt.mockResolvedValue({
      id: 601,
      intakeDocumentId: intakeDoc.id,
      attempts: 0,
    });
    storageSpy.getProjectIntakeDocument.mockResolvedValue(intakeDoc);
    parseDocumentMock.mockResolvedValue(realParsed);

    await attemptIntakeJob(601);

    // The queue itself invoked parseDocument (inheriting chunked extraction).
    expect(parseDocumentMock).toHaveBeenCalledTimes(1);
    expect(storageSpy.markIntakeJobSucceeded).toHaveBeenCalledTimes(1);
    expect(storageSpy.markIntakeJobDeadLettered).not.toHaveBeenCalled();

    // Coverage metadata persisted on the intake document's extractedData.
    const provenance = storageSpy.updateProjectIntakeDocument.mock.calls
      .map((c) => c[1] as { extractedData?: { extractionCoverage?: CoverageShape } })
      .find((u) => u.extractedData?.extractionCoverage);
    expect(provenance).toBeDefined();
    expectFullCoverage(provenance!.extractedData!.extractionCoverage);

    // Routed to a devis — NOT parked by the completeness advisory.
    expect(storageSpy.createDevis).toHaveBeenCalledTimes(1);
    const promotion = storageSpy.updateProjectIntakeDocument.mock.calls
      .map((c) => c[1] as Record<string, unknown>)
      .find((u) => u.routingState === "routed");
    expect(promotion).toBeDefined();
    expect(promotion!.promotedKind).toBe("devis");

    const row = storageSpy.createDevis.mock.calls[0][0] as {
      aiExtractedData: ParsedDocument;
      validationWarnings: WarningShape[];
      amountHt: string;
    };
    expectFullCoverage(row.aiExtractedData.extractionCoverage as CoverageShape);
    expectAdvisoriesWithoutBlocking(row.validationWarnings);
    expect(row.amountHt).toBe("7000");

    // All 7 line items persisted with rebased page hints (page 6 covered).
    expect(storageSpy.createDevisLineItem).toHaveBeenCalledTimes(7);
    const hints = storageSpy.createDevisLineItem.mock.calls.map(
      (c) => (c[0] as { pdfPageHint: number | null }).pdfPageHint,
    );
    expect(hints).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
});

describe("invoice upload — long-PDF parse flows coverage into the persisted invoice (Task #352)", () => {
  const DEVIS = {
    id: 7,
    devisCode: "DVP0000661",
    projectId: 3,
    contractorId: 11,
    lotId: null,
    acompteRequired: false,
    acompteState: "not_required",
  };

  it("full coverage + numbering advisory persists; NOT rejected as EXTRACTION_INCOMPLETE", async () => {
    storageSpy.getDevis.mockResolvedValue(DEVIS);
    parseDocumentMock.mockResolvedValue({ ...realParsed, documentType: "invoice" });

    const result = await processInvoiceUpload(7, {
      buffer: FIXTURE_PDF,
      originalname: "seven-page-invoice.pdf",
      mimetype: "application/pdf",
    });

    expect(result.success).toBe(true);
    expect(result.status).toBe(201);
    expect(parseDocumentMock).toHaveBeenCalledTimes(1);
    expect(storageSpy.createInvoice).toHaveBeenCalledTimes(1);

    const row = storageSpy.createInvoice.mock.calls[0][0] as {
      aiExtractedData: ParsedDocument;
      validationWarnings: WarningShape[];
      amountHt: string;
      amountTtc: string;
    };
    expectFullCoverage(row.aiExtractedData.extractionCoverage as CoverageShape);
    expectAdvisoriesWithoutBlocking(row.validationWarnings);
    expect(row.amountHt).toBe("7000");
    expect(row.amountTtc).toBe("8400");

    // The advisory also surfaces in the API response payload.
    const warnings = (result.data as { validation: { warnings: WarningShape[] } }).validation.warnings;
    expectAdvisoriesWithoutBlocking(warnings);
  });

  it("control: the SAME parse with pages missing from coverage IS hard-gated (advisory ≠ gate)", async () => {
    storageSpy.getDevis.mockResolvedValue(DEVIS);
    parseDocumentMock.mockResolvedValue({
      ...realParsed,
      documentType: "invoice",
      extractionCoverage: { ...realParsed.extractionCoverage!, renderedPageCount: 5 },
    });

    const result = await processInvoiceUpload(7, {
      buffer: FIXTURE_PDF,
      originalname: "seven-page-invoice.pdf",
      mimetype: "application/pdf",
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(422);
    expect((result.data as { code: string }).code).toBe("EXTRACTION_INCOMPLETE");
    expect(storageSpy.createInvoice).not.toHaveBeenCalled();
    expect(uploadDocumentSpy).not.toHaveBeenCalled();
  });
});

describe("benchmark ingest — long-PDF parse flows coverage into the benchmark document (Task #352)", () => {
  it("standalone upload succeeds; coverage + advisory persist on the benchmark doc; all 7 items created", async () => {
    parseDocumentMock.mockResolvedValue(realParsed);

    const result = await processStandaloneBenchmarkUpload(
      {
        buffer: FIXTURE_PDF,
        originalname: "seven-page-benchmark.pdf",
        mimetype: "application/pdf",
      },
      { contractorId: 11 },
    );

    expect(result.success).toBe(true);
    expect(result.status).toBe(201);
    expect(parseDocumentMock).toHaveBeenCalledTimes(1);

    const row = storageSpy.createBenchmarkDocument.mock.calls[0][0] as {
      aiExtractedData: ParsedDocument;
      validationWarnings: WarningShape[];
      totalHt: string | null;
    };
    expectFullCoverage(row.aiExtractedData.extractionCoverage as CoverageShape);
    expectAdvisoriesWithoutBlocking(row.validationWarnings);
    expect(row.totalHt).toBe("7000");

    // Every extracted line landed as a benchmark item — no silent drops.
    expect(storageSpy.createBenchmarkItem).toHaveBeenCalledTimes(7);
    expect((result.data as { itemsCreated: number }).itemsCreated).toBe(7);

    // Advisory surfaces in the API response too — no hard gating exists on
    // this path (benchmarks are review-queued via needsReview, not blocked).
    const warnings = (result.data as { validation: { warnings: WarningShape[] } }).validation.warnings;
    expectAdvisoriesWithoutBlocking(warnings);

    // Full-coverage, hinted parse ⇒ no completeness-forced review flag.
    expect((result.data as { needsReview: boolean }).needsReview).toBe(false);
    expect((result.data as { reviewReasons: string[] }).reviewReasons).toEqual([]);
  });

  it("blocking completeness error (missing page coverage) is NOT hard-gated but ALWAYS forces needsReview with a surfaced reason (Task #354)", async () => {
    parseDocumentMock.mockResolvedValue({
      ...realParsed,
      extractionCoverage: { ...realParsed.extractionCoverage!, renderedPageCount: 5 },
    });

    const result = await processStandaloneBenchmarkUpload(
      {
        buffer: FIXTURE_PDF,
        originalname: "seven-page-benchmark.pdf",
        mimetype: "application/pdf",
      },
      { contractorId: 11 },
    );

    // No completeness hard gate on this path — persistence succeeds…
    expect(result.success).toBe(true);
    expect(result.status).toBe(201);
    expect(storageSpy.createBenchmarkDocument).toHaveBeenCalledTimes(1);

    // …but the document row is force-flagged for review with the blocking
    // pageCoverage error persisted in its warnings.
    const row = storageSpy.createBenchmarkDocument.mock.calls[0][0] as {
      needsReview: boolean;
      validationWarnings: WarningShape[];
    };
    expect(row.needsReview).toBe(true);
    const coverageWarning = row.validationWarnings.find((w) => w.field === "pageCoverage");
    expect(coverageWarning).toBeDefined();
    expect(coverageWarning!.severity).toBe("error");

    // Every created item inherits the review flag — partial data never
    // quietly enters price comparisons.
    for (const call of storageSpy.createBenchmarkItem.mock.calls) {
      expect((call[0] as { needsReview: boolean }).needsReview).toBe(true);
    }

    // The reason is surfaced in the API response for the UI.
    const data = result.data as { needsReview: boolean; reviewReasons: string[] };
    expect(data.needsReview).toBe(true);
    expect(data.reviewReasons.length).toBeGreaterThan(0);
    expect(data.reviewReasons[0]).toContain("5 of 7");
  });
});

describe("devis re-scrape — long-PDF parse flows coverage into the updated devis (Task #353)", () => {
  const DEVIS_ROW = {
    id: 42,
    devisCode: "DVP0000042",
    devisNumber: "DEV-2026-777",
    projectId: 3,
    contractorId: 11,
    lotId: null,
    status: "sent",
    invoicingMode: "mode_a",
    amountHt: "100",
    amountTtc: "120",
    dateSent: null,
    pdfStorageKey: "devis/42/seven-page-devis.pdf",
    pdfFileName: "seven-page-devis.pdf",
  };

  beforeEach(() => {
    txSpies.lockedRow = { ...DEVIS_ROW };
    storageSpy.getDevis.mockResolvedValue({ ...DEVIS_ROW });
  });

  it("full coverage + numbering advisory persist on the devis; line items replaced with rebased hints", async () => {
    parseDocumentMock.mockResolvedValue(realParsed);

    const result = await rescrapeDevis(42);

    expect(result.success).toBe(true);
    expect(result.status).toBe(200);
    expect(parseDocumentMock).toHaveBeenCalledTimes(1);
    expect(dbSpy.transaction).toHaveBeenCalledTimes(1);
    expect(txSpies.updateSet).toHaveBeenCalledTimes(1);

    // Coverage metadata + advisories persisted on the devis update.
    const update = txSpies.updateSet.mock.calls[0][0] as {
      aiExtractedData: ParsedDocument;
      validationWarnings: WarningShape[];
      amountHt: string;
      amountTtc: string;
      invoicingMode: string;
    };
    expectFullCoverage(update.aiExtractedData.extractionCoverage as CoverageShape);
    expectAdvisoriesWithoutBlocking(update.validationWarnings);
    expect(update.amountHt).toBe("7000");
    expect(update.amountTtc).toBe("8400");
    // Lines appeared on the re-scrape ⇒ mode_a flips to mode_b.
    expect(update.invoicingMode).toBe("mode_b");

    // All 7 line items re-created with rebased page hints (page 6 covered).
    expect(txSpies.insertValues).toHaveBeenCalledTimes(1);
    const rows = txSpies.insertValues.mock.calls[0][0] as Array<{
      pdfPageHint: number | null;
      lineNumber: number;
    }>;
    expect(rows).toHaveLength(7);
    expect(rows.map((r) => r.pdfPageHint)).toEqual([1, 2, 3, 4, 5, 6, 7]);

    // Advisories surface in the API response payload too.
    const validation = (result.data as { validation: { warnings: WarningShape[] } }).validation;
    expectAdvisoriesWithoutBlocking(validation.warnings);
    const extraction = (result.data as { extraction: { lineItemsCreated: number } }).extraction;
    expect(extraction.lineItemsCreated).toBe(7);
  });

  it("control: the SAME parse with pages missing from coverage is hard-gated — existing data untouched", async () => {
    parseDocumentMock.mockResolvedValue({
      ...realParsed,
      extractionCoverage: { ...realParsed.extractionCoverage!, renderedPageCount: 5 },
    });

    const result = await rescrapeDevis(42);

    expect(result.success).toBe(false);
    expect(result.status).toBe(422);
    expect((result.data as { code: string }).code).toBe("EXTRACTION_INCOMPLETE");
    // Gate fires BEFORE the transaction: no lock taken, no update, no
    // delete/insert — the existing extraction survives intact.
    expect(dbSpy.transaction).not.toHaveBeenCalled();
    expect(txSpies.updateSet).not.toHaveBeenCalled();
    expect(txSpies.insertValues).not.toHaveBeenCalled();
    expect(txSpies.execute).not.toHaveBeenCalled();
  });
});
