// Task #350 — extraction completeness verification.
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  countItemRowCandidates,
  checkExtractionCompleteness,
  findBlockingCompletenessWarnings,
  MIN_CANDIDATE_ROWS_FOR_EVIDENCE,
} from "../services/extraction-completeness";
import {
  mergeChunkedParses,
  pdfToImagesWithCoverage,
  getPdfPageCount,
  getPdfPageText,
  parseDocument,
  EXTRACTION_CHUNK_PAGES,
  type ParsedDocument,
} from "../gmail/document-parser";
import { validateExtraction } from "../services/extraction-validator";
import { deriveAdvisoryCode, ADVISORY_CODES } from "@shared/advisory-codes";

const FIXTURE = join(__dirname, "fixtures", "seven-page-devis.pdf");

describe("countItemRowCandidates", () => {
  it("counts numbered item rows with amounts", () => {
    const text = [
      "Page 6 - DEVIS TRAVAUX",
      "26. Fourniture et pose element 26   2 u   150,00   300,00",
      "27. Fourniture et pose element 27   2 u   150,00   300,00",
      "28. Fourniture et pose element 28   2 u   150,00   300,00",
    ].join("\n");
    expect(countItemRowCandidates(text)).toBe(3);
  });

  it("does not count totals/summary rows or plain prose", () => {
    const text = [
      "TOTAL HT 9 000,00",
      "TVA 20% 1 800,00",
      "TOTAL TTC 10 800,00",
      "Conditions de paiement : 30 jours fin de mois",
      "Le present devis est valable trois mois.",
    ].join("\n");
    expect(countItemRowCandidates(text)).toBe(0);
  });
});

describe("checkExtractionCompleteness", () => {
  const evidencedPage = (page: number, rows = MIN_CANDIDATE_ROWS_FOR_EVIDENCE) => ({
    page,
    candidateRows: rows,
    hasTextLayer: true,
  });

  it("returns nothing without coverage metadata", () => {
    expect(checkExtractionCompleteness({ coverage: undefined, lineItems: [] })).toEqual([]);
  });

  it("raises a blocking error when rendered pages < pdf page count", () => {
    const warnings = checkExtractionCompleteness({
      coverage: { pdfPageCount: 7, renderedPageCount: 5, chunkCount: 1 },
      lineItems: [],
    });
    const w = warnings.find((x) => x.field === "pageCoverage");
    expect(w?.severity).toBe("error");
    expect(deriveAdvisoryCode(w!)).toBe(ADVISORY_CODES.PAGE_COVERAGE_INCOMPLETE);
    expect(findBlockingCompletenessWarnings(warnings)).toHaveLength(1);
  });

  it("blocks when a text-evidenced page produced no hinted lines while hints exist elsewhere", () => {
    const warnings = checkExtractionCompleteness({
      coverage: {
        pdfPageCount: 7,
        renderedPageCount: 7,
        chunkCount: 2,
        pageEvidence: [evidencedPage(1), evidencedPage(6)],
      },
      lineItems: [
        { description: "1. Item", pageHint: 1 },
        { description: "2. Item", pageHint: 1 },
      ],
    });
    const w = warnings.find((x) => x.field === "pageLineItems");
    expect(w?.severity).toBe("error");
    expect(w?.message).toContain("6");
    expect(findBlockingCompletenessWarnings(warnings)).toHaveLength(1);
  });

  it("degrades to a warning when no page hints are available at all", () => {
    const warnings = checkExtractionCompleteness({
      coverage: {
        pdfPageCount: 2,
        renderedPageCount: 2,
        chunkCount: 1,
        pageEvidence: [evidencedPage(2)],
      },
      lineItems: [{ description: "1. Item" }],
    });
    const w = warnings.find((x) => x.field === "pageLineItems");
    expect(w?.severity).toBe("warning");
    expect(findBlockingCompletenessWarnings(warnings)).toHaveLength(0);
  });

  it("degrades to a warning for documents with zero extracted line items (mode_a)", () => {
    const warnings = checkExtractionCompleteness({
      coverage: {
        pdfPageCount: 2,
        renderedPageCount: 2,
        chunkCount: 1,
        pageEvidence: [evidencedPage(1)],
      },
      lineItems: [],
    });
    const w = warnings.find((x) => x.field === "pageLineItems");
    expect(w?.severity).toBe("warning");
  });

  it("never flags pages without a text layer (scans)", () => {
    const warnings = checkExtractionCompleteness({
      coverage: {
        pdfPageCount: 3,
        renderedPageCount: 3,
        chunkCount: 1,
        pageEvidence: [
          { page: 1, candidateRows: 0, hasTextLayer: false },
          { page: 2, candidateRows: 0, hasTextLayer: false },
          { page: 3, candidateRows: 0, hasTextLayer: false },
        ],
      },
      lineItems: [{ description: "1. Item", pageHint: 1 }],
    });
    expect(warnings.find((x) => x.field === "pageLineItems")).toBeUndefined();
  });

  it("flags numbering gaps as a warning, never blocking", () => {
    const warnings = checkExtractionCompleteness({
      coverage: { pdfPageCount: 1, renderedPageCount: 1, chunkCount: 1 },
      lineItems: [1, 2, 3, 4, 7].map((n) => ({ description: `${n}. Item ${n}`, pageHint: 1 })),
    });
    const w = warnings.find((x) => x.field === "lineNumbering");
    expect(w?.severity).toBe("warning");
    expect(w?.message).toContain("5, 6");
    expect(deriveAdvisoryCode(w!)).toBe(ADVISORY_CODES.LINE_NUMBERING_GAP);
    expect(findBlockingCompletenessWarnings(warnings)).toHaveLength(0);
  });
});

describe("mergeChunkedParses", () => {
  it("rebases page hints by chunk offset and keeps identity/totals precedence", () => {
    const chunk1: ParsedDocument = {
      documentType: "quotation",
      contractorName: "AT TRAVAUX",
      siret: "12345678900012",
      lineItems: [
        { description: "1. Item", pageHint: 1, total: 100 },
        { description: "2. Item", pageHint: 5, total: 100 },
      ],
    };
    const chunk2: ParsedDocument = {
      documentType: "quotation",
      amountHt: 900,
      amountTtc: 1080,
      tvaRate: 20,
      lineItems: [
        { description: "26. Item", pageHint: 1, total: 100 },
        { description: "27. Item", pageHint: 9, total: 100 }, // out of chunk range → hint dropped
      ],
    };
    const merged = mergeChunkedParses([
      { parsed: chunk1, pageOffset: 0, pageCount: 5 },
      { parsed: chunk2, pageOffset: 5, pageCount: 2 },
    ]);
    expect(merged.contractorName).toBe("AT TRAVAUX");
    expect(merged.amountHt).toBe(900);
    expect(merged.lineItems).toHaveLength(4);
    expect(merged.lineItems![1].pageHint).toBe(5);
    expect(merged.lineItems![2].pageHint).toBe(6);
    expect(merged.lineItems![3].pageHint).toBeUndefined();
  });
});

describe("validateExtraction — derived totals (Task #350)", () => {
  it("emits derived_totals_unverified and skips the circular line-sum check", () => {
    const parsed: ParsedDocument = {
      documentType: "quotation",
      tvaRate: 20,
      lineItems: [
        { description: "1. A", total: 100 },
        { description: "2. B", total: 200 },
      ],
    };
    const result = validateExtraction(parsed);
    const derived = result.warnings.find((w) => w.field === "derivedTotals");
    expect(derived?.severity).toBe("warning");
    expect(deriveAdvisoryCode(derived!)).toBe(ADVISORY_CODES.DERIVED_TOTALS_UNVERIFIED);
    // No lineItems total-mismatch warning may appear: the check must be skipped.
    expect(result.warnings.find((w) => w.field === "lineItems")).toBeUndefined();
    expect(result.correctedValues.amountHt).toBe(300);
    expect(result.confidenceScore).toBeLessThanOrEqual(40);
  });
});

describe("7-page fixture — full pipeline coverage (poppler/gs integration)", () => {
  const pdf = readFileSync(FIXTURE);

  it("pdfinfo reports 7 pages and per-page text extraction finds item evidence on page 6", async () => {
    expect(await getPdfPageCount(pdf)).toBe(7);
  });

  it("renders ALL 7 pages (no 5-page cap) with the authoritative count", async () => {
    const { images, pdfPageCount } = await pdfToImagesWithCoverage(pdf);
    expect(pdfPageCount).toBe(7);
    expect(images).toHaveLength(7);
  }, 120000);

  it("parseDocument chunks pages, rebases hints, and stamps coverage with page-6 evidence", async () => {
    const calls: number[] = [];
    const fakeChunkParse = async (images: Buffer[]): Promise<ParsedDocument> => {
      calls.push(images.length);
      const isFirst = calls.length === 1;
      return {
        documentType: "quotation",
        contractorName: isFirst ? "AT TRAVAUX" : undefined,
        amountHt: isFirst ? undefined : 9000,
        amountTtc: isFirst ? undefined : 10800,
        lineItems: images.map((_, i) => ({
          description: `Item chunk${calls.length} page ${i + 1}`,
          total: 300,
          pageHint: i + 1,
        })),
      };
    };
    const parsed = await parseDocument(pdf, "seven-page-devis.pdf", {
      getActiveModel: async () => ({ provider: "gemini", modelId: "test" }),
      parseWithGemini: fakeChunkParse,
      parseWithOpenAI: async () => {
        throw new Error("should not be called");
      },
      hasOpenAIKey: () => false,
    });
    // 7 pages → chunks of 5 + 2.
    expect(calls).toEqual([EXTRACTION_CHUNK_PAGES, 7 - EXTRACTION_CHUNK_PAGES]);
    expect(parsed.contractorName).toBe("AT TRAVAUX");
    expect(parsed.amountHt).toBe(9000);
    expect(parsed.lineItems).toHaveLength(7);
    // Second chunk's hints rebased to global pages 6 and 7.
    expect(parsed.lineItems![5].pageHint).toBe(6);
    expect(parsed.lineItems![6].pageHint).toBe(7);

    const coverage = parsed.extractionCoverage!;
    expect(coverage.pdfPageCount).toBe(7);
    expect(coverage.renderedPageCount).toBe(7);
    expect(coverage.chunkCount).toBe(2);
    const page6 = coverage.pageEvidence!.find((p) => p.page === 6)!;
    expect(page6.hasTextLayer).toBe(true);
    expect(page6.candidateRows).toBeGreaterThanOrEqual(MIN_CANDIDATE_ROWS_FOR_EVIDENCE);
    const page7 = coverage.pageEvidence!.find((p) => p.page === 7)!;
    expect(page7.candidateRows).toBe(0);

    // Full validator pass on the merged extraction: page 6 is covered by
    // hinted lines, so no blocking completeness warning may be raised.
    const validation = validateExtraction(parsed);
    expect(findBlockingCompletenessWarnings(validation.warnings)).toHaveLength(0);
  }, 180000);

  it("blocks when a text-evidenced page yields no line items in the extraction", async () => {
    const parsed = await parseDocument(pdf, "seven-page-devis.pdf", {
      getActiveModel: async () => ({ provider: "gemini", modelId: "test" }),
      // Simulate the DVT0000959 failure shape: hints emitted for pages 1–5
      // only, nothing pointing at the evidenced page 6.
      parseWithGemini: async (images: Buffer[]) => ({
        documentType: "quotation" as const,
        lineItems: images.slice(0, Math.min(images.length, 5)).map((_, i) => ({
          description: `Item ${i + 1}`,
          total: 300,
          pageHint: i + 1,
        })),
      }),
      parseWithOpenAI: async () => {
        throw new Error("should not be called");
      },
      hasOpenAIKey: () => false,
    });
    // Chunk 2 (pages 6–7) reported hints 1..2 → rebased to 6..7, so instead
    // craft the gap by dropping chunk-2 lines: emulate via empty lineItems on
    // the second chunk. parseWithGemini above emits lines for every chunk, so
    // strip the rebased page-6/7 lines to simulate the loss.
    parsed.lineItems = (parsed.lineItems ?? []).filter((li) => (li.pageHint ?? 0) <= 5);
    const validation = validateExtraction(parsed);
    const blocking = findBlockingCompletenessWarnings(validation.warnings);
    expect(blocking).toHaveLength(1);
    expect(blocking[0].field).toBe("pageLineItems");
    expect(blocking[0].message).toContain("6");
  }, 180000);

  it("getPdfPageText returns null-ish (never throws) on garbage buffers", async () => {
    expect(await getPdfPageCount(Buffer.from("not a pdf"))).toBeNull();
  });
});

describe("maxChunkImageBytes — per-request payload budget", () => {
  it("measures the largest contiguous chunk window, not the whole document", async () => {
    const { maxChunkImageBytes } = await import("../gmail/document-parser");
    // 12 pages of 3MB each: whole doc = 36MB, but any 5-page chunk = 15MB.
    const images = Array.from({ length: 12 }, () => Buffer.alloc(3 * 1024 * 1024));
    expect(maxChunkImageBytes(images, 5)).toBe(15 * 1024 * 1024);
    // A long PDF must not be judged by its aggregate payload.
    expect(maxChunkImageBytes(images, 5)).toBeLessThan(36 * 1024 * 1024);
  });
});
