import { describe, it, expect, vi, beforeEach } from "vitest";

// Task #112 — verifies the backfill helper's per-devis update logic:
//  - pdfPageHint coercion mirrors the upload-time path (only strict positive
//    integers persist; everything else degrades to null)
//  - existing non-null hints are NEVER overwritten (idempotency / AI drift
//    safety)
//  - non-hint columns (description, totals, line numbers) are NEVER written
//    on update — only pdfPageHint flows through
//  - devis whose lines are all already hinted skip the AI re-extraction
//    entirely (cost guard for re-running the maintenance command)

const { dbState, parseDocumentMock, getDocumentBufferMock } = vi.hoisted(() => ({
  dbState: {
    devisRows: [] as Array<Record<string, unknown>>,
    lineRows: [] as Array<Record<string, unknown>>,
    updates: [] as Array<{ values: Record<string, unknown> }>,
  },
  parseDocumentMock: vi.fn(),
  getDocumentBufferMock: vi.fn(async () => Buffer.from("%PDF-1.4 fake")),
}));

vi.mock("../../server/db", async () => {
  const { devis } = await import("@shared/schema");
  return {
    db: {
      select() {
        const chain: any = {
          _table: null as unknown,
          from(t: unknown) { chain._table = t; return chain; },
          where() { return chain; },
          orderBy() { return chain; },
          limit() { return chain; },
          then(resolve: (rows: unknown[]) => unknown) {
            const rows = chain._table === devis ? dbState.devisRows : dbState.lineRows;
            return Promise.resolve(rows).then(resolve);
          },
        };
        return chain;
      },
      update() {
        return {
          set(values: Record<string, unknown>) {
            return {
              where() {
                dbState.updates.push({ values });
                return Promise.resolve();
              },
            };
          },
        };
      },
    },
  };
});
vi.mock("../../server/storage/object-storage", () => ({
  getDocumentBuffer: getDocumentBufferMock,
}));
vi.mock("../../server/gmail/document-parser", () => ({
  parseDocument: parseDocumentMock,
}));

import { backfillOne, coercePageHint } from "../backfill-page-hints";

beforeEach(() => {
  vi.clearAllMocks();
  dbState.devisRows = [];
  dbState.lineRows = [];
  dbState.updates = [];
});

describe("coercePageHint", () => {
  it("accepts strict positive integers, floors floats, and rejects everything else", () => {
    expect(coercePageHint(1)).toBe(1);
    expect(coercePageHint(7)).toBe(7);
    expect(coercePageHint(2.7)).toBe(2);
    expect(coercePageHint(0)).toBeNull();
    expect(coercePageHint(-3)).toBeNull();
    expect(coercePageHint(NaN)).toBeNull();
    expect(coercePageHint(Infinity)).toBeNull();
    expect(coercePageHint(null)).toBeNull();
    expect(coercePageHint(undefined)).toBeNull();
    expect(coercePageHint("4")).toBeNull();
  });
});

describe("backfillOne", () => {
  it("skips devis whose line items already all have a page hint (no AI call)", async () => {
    dbState.devisRows = [
      { id: 42, pdfStorageKey: "k/42.pdf", pdfFileName: "42.pdf", devisCode: "D-42" },
    ];
    dbState.lineRows = [
      { id: 1, devisId: 42, lineNumber: 1, pdfPageHint: 1 },
      { id: 2, devisId: 42, lineNumber: 2, pdfPageHint: 3 },
    ];

    const stats = await backfillOne(42, false);

    expect(stats.status).toBe("skipped-already-complete");
    expect(parseDocumentMock).not.toHaveBeenCalled();
    expect(getDocumentBufferMock).not.toHaveBeenCalled();
    expect(dbState.updates).toHaveLength(0);
  });

  it("skips devis with no stored PDF", async () => {
    dbState.devisRows = [
      { id: 5, pdfStorageKey: null, pdfFileName: null, devisCode: "D-5" },
    ];
    const stats = await backfillOne(5, false);
    expect(stats.status).toBe("skipped-no-pdf");
    expect(parseDocumentMock).not.toHaveBeenCalled();
  });

  it("fills only currently-null hints, coerces invalid AI values, never overwrites existing hints, and writes only pdfPageHint", async () => {
    dbState.devisRows = [
      { id: 7, pdfStorageKey: "k/7.pdf", pdfFileName: "7.pdf", devisCode: "D-7" },
    ];
    dbState.lineRows = [
      { id: 100, devisId: 7, lineNumber: 1, pdfPageHint: null },  // → 2
      { id: 101, devisId: 7, lineNumber: 2, pdfPageHint: 5 },     // existing — untouched
      { id: 102, devisId: 7, lineNumber: 3, pdfPageHint: null },  // AI says 0 → skip
      { id: 103, devisId: 7, lineNumber: 4, pdfPageHint: null },  // AI says 2.7 → 2
      { id: 104, devisId: 7, lineNumber: 5, pdfPageHint: null },  // AI omits → skip
      { id: 105, devisId: 7, lineNumber: 6, pdfPageHint: null },  // AI says "4" string → skip
    ];
    parseDocumentMock.mockResolvedValue({
      documentType: "quotation",
      lineItems: [
        { description: "L1", pageHint: 2 },
        { description: "L2", pageHint: 99 }, // ignored — line 2 already hinted
        { description: "L3", pageHint: 0 },
        { description: "L4", pageHint: 2.7 },
        { description: "L5" },
        { description: "L6", pageHint: "4" },
      ],
    });

    const stats = await backfillOne(7, false);

    expect(stats.status).toBe("updated");
    expect(stats.updated).toBe(2);
    expect(stats.alreadyHinted).toBe(1);
    expect(stats.lineItems).toBe(6);
    expect(parseDocumentMock).toHaveBeenCalledTimes(1);
    expect(dbState.updates).toHaveLength(2);
    for (const u of dbState.updates) {
      // Invariant: re-extraction MUST NOT mutate description, totals, or
      // line numbers. Only pdfPageHint may be written.
      expect(Object.keys(u.values)).toEqual(["pdfPageHint"]);
    }
    expect(dbState.updates.map((u) => u.values.pdfPageHint)).toEqual([2, 2]);
  });

  it("dry-run never writes even when valid hints are available", async () => {
    dbState.devisRows = [
      { id: 9, pdfStorageKey: "k/9.pdf", pdfFileName: "9.pdf", devisCode: "D-9" },
    ];
    dbState.lineRows = [
      { id: 200, devisId: 9, lineNumber: 1, pdfPageHint: null },
    ];
    parseDocumentMock.mockResolvedValue({
      documentType: "quotation",
      lineItems: [{ description: "L1", pageHint: 1 }],
    });

    const stats = await backfillOne(9, true);

    expect(stats.status).toBe("updated");
    expect(stats.updated).toBe(1);
    expect(parseDocumentMock).toHaveBeenCalledTimes(1);
    expect(dbState.updates).toHaveLength(0);
  });

  it("reports no-new-hints when the AI cannot supply a page for any pending line", async () => {
    dbState.devisRows = [
      { id: 11, pdfStorageKey: "k/11.pdf", pdfFileName: "11.pdf", devisCode: "D-11" },
    ];
    dbState.lineRows = [
      { id: 300, devisId: 11, lineNumber: 1, pdfPageHint: null },
      { id: 301, devisId: 11, lineNumber: 2, pdfPageHint: null },
    ];
    parseDocumentMock.mockResolvedValue({
      documentType: "quotation",
      lineItems: [
        { description: "L1" },
        { description: "L2", pageHint: 0 },
      ],
    });

    const stats = await backfillOne(11, false);

    expect(stats.status).toBe("no-new-hints");
    expect(stats.updated).toBe(0);
    expect(dbState.updates).toHaveLength(0);
  });

  it("skips when re-extraction returns no line items", async () => {
    dbState.devisRows = [
      { id: 12, pdfStorageKey: "k/12.pdf", pdfFileName: "12.pdf", devisCode: "D-12" },
    ];
    dbState.lineRows = [
      { id: 400, devisId: 12, lineNumber: 1, pdfPageHint: null },
    ];
    parseDocumentMock.mockResolvedValue({ documentType: "unknown" });

    const stats = await backfillOne(12, false);

    expect(stats.status).toBe("skipped-no-extracted-lines");
    expect(dbState.updates).toHaveLength(0);
  });
});
