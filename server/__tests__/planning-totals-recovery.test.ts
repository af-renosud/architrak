import { describe, expect, it, vi } from "vitest";
import { roundCurrency } from "../../shared/financial-utils";
import type {
  ParsedDocument,
  PlanningSummaryLineCandidate,
} from "../gmail/document-parser";
import { validateExtraction } from "../services/extraction-validator";
import { recoverPlanningTotalsBoxLines } from "../services/planning-totals-recovery.service";

function makeParsed(overrides: Partial<ParsedDocument> = {}): ParsedDocument {
  return {
    documentType: "quotation",
    amountHt: 500,
    amountTtc: 600,
    tvaAmount: 100,
    lineItems: [
      { description: "Existing work", total: 100 },
    ],
    ...overrides,
  };
}

function candidate(
  description: string,
  totalHt: number,
  overrides: Partial<PlanningSummaryLineCandidate> = {},
): PlanningSummaryLineCandidate {
  return {
    description,
    totalHt,
    evidenceText: "OPTIONS RETENUES DANS LE TOTAL",
    includedInTotal: true,
    amountBasis: "HT",
    ...overrides,
  };
}

describe("Planning totals-box line recovery", () => {
  it("recovers Richardson-style options and reconciles the rounded HT total", async () => {
    const parsed = makeParsed({
      amountHt: 17_463.87,
      amountTtc: 20_957.83,
      tvaAmount: 3_493.96,
      lineItems: [
        { description: "Previously extracted pages and body rows", total: 10_000 },
        { description: "Final-page main table rows", total: 908 },
      ],
    });
    const recoverCandidates = vi.fn(async () => [
      candidate("HAUTEUR DE RETOMBÉE 40 CM - SANS TROP PLEIN", 1_693.90, {
        pageHint: 4,
      }),
      candidate("DOUCHE ENCASTRÉ MOBIL INOX BROSSÉ", 1_646.71, {
        pageHint: 4,
      }),
      candidate("RECEVEUR DE DOUCHE UNIQUE SCENE BLANC 130X230", 3_215.26, {
        pageHint: 4,
      }),
    ]);

    const result = await recoverPlanningTotalsBoxLines({
      pdfBuffer: Buffer.from("pdf"),
      fileName: "richardson.pdf",
      parsed,
      validation: validateExtraction(parsed),
      recoverCandidates,
    });

    expect(recoverCandidates).toHaveBeenCalledWith(
      expect.any(Buffer),
      "richardson.pdf",
      {
        expectedHt: 17_463.87,
        lineItemsTotal: 10_908,
        difference: 6_555.87,
      },
    );
    expect(result.parsed.lineItems).toHaveLength(5);
    expect(result.parsed.lineItems?.slice(-3)).toEqual([
      {
        description: "HAUTEUR DE RETOMBÉE 40 CM - SANS TROP PLEIN",
        total: 1_693.90,
        pageHint: 4,
      },
      {
        description: "DOUCHE ENCASTRÉ MOBIL INOX BROSSÉ",
        total: 1_646.71,
        pageHint: 4,
      },
      {
        description: "RECEVEUR DE DOUCHE UNIQUE SCENE BLANC 130X230",
        total: 3_215.26,
        pageHint: 4,
      },
    ]);
    const finalTotal = roundCurrency(
      result.parsed.lineItems!.reduce((sum, item) => sum + (item.total ?? 0), 0),
    );
    expect(finalTotal).toBe(17_463.87);
    expect(result.parsed.planningSummaryRecovery).toMatchObject({
      attempted: true,
      status: "reconciled",
      candidateCount: 3,
      recoveredCount: 3,
      ambiguousCandidateCount: 0,
      recoveredTotal: 6_555.87,
      finalLineItemsTotal: 17_463.87,
      recoveredEvidence: [
        expect.objectContaining({
          description: "HAUTEUR DE RETOMBÉE 40 CM - SANS TROP PLEIN",
          totalHt: 1_693.90,
          evidenceText: "OPTIONS RETENUES DANS LE TOTAL",
          pageHint: 4,
        }),
        expect.objectContaining({
          description: "DOUCHE ENCASTRÉ MOBIL INOX BROSSÉ",
          totalHt: 1_646.71,
        }),
        expect.objectContaining({
          description: "RECEVEUR DE DOUCHE UNIQUE SCENE BLANC 130X230",
          totalHt: 3_215.26,
        }),
      ],
    });
    expect(result.validation.warnings).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ field: "lineItems" })]),
    );
  });

  it("skips recovery when the existing validator identifies VAT-inclusive lines", async () => {
    const parsed = makeParsed({
      amountHt: 100,
      amountTtc: 120,
      tvaAmount: 20,
      lineItems: [{ description: "VAT-inclusive printed row", total: 120 }],
    });
    const validation = validateExtraction(parsed);
    const recoverCandidates = vi.fn();

    const result = await recoverPlanningTotalsBoxLines({
      pdfBuffer: Buffer.from("pdf"),
      fileName: "vat-inclusive.pdf",
      parsed,
      validation,
      recoverCandidates,
    });

    expect(parsed.lineItemsVatCheck?.vatInclusive).toBe(true);
    expect(recoverCandidates).not.toHaveBeenCalled();
    expect(result).toEqual({ parsed, validation });
  });

  it("deduplicates an already-extracted option before merging a missing one", async () => {
    const parsed = makeParsed({
      amountHt: 200,
      amountTtc: 240,
      tvaAmount: 40,
      lineItems: [
        { description: "Base work", total: 100 },
        { description: "Option déjà extraite", total: 40 },
      ],
    });

    const result = await recoverPlanningTotalsBoxLines({
      pdfBuffer: Buffer.from("pdf"),
      fileName: "duplicate-option.pdf",
      parsed,
      validation: validateExtraction(parsed),
      recoverCandidates: async () => [
        candidate("OPTION DEJA EXTRAITE", 40),
        candidate("Option réellement manquante", 60),
      ],
    });

    expect(result.parsed.lineItems?.filter((item) => item.total === 40)).toHaveLength(1);
    expect(result.parsed.lineItems?.at(-1)).toEqual({
      description: "Option réellement manquante",
      total: 60,
    });
    expect(result.parsed.planningSummaryRecovery).toMatchObject({
      status: "reconciled",
      candidateCount: 2,
      recoveredCount: 1,
    });
  });

  it("leaves the draft flagged when a same-amount near-duplicate is ambiguous", async () => {
    const parsed = makeParsed({
      amountHt: 200,
      amountTtc: 240,
      tvaAmount: 40,
      lineItems: [
        { description: "Receveur douche scène blanc 130 x 230", total: 50 },
        { description: "Base work", total: 100 },
      ],
    });
    const result = await recoverPlanningTotalsBoxLines({
      pdfBuffer: Buffer.from("pdf"),
      fileName: "ambiguous-repeat.pdf",
      parsed,
      validation: validateExtraction(parsed),
      recoverCandidates: async () => [
        candidate("RECEVEUR DE DOUCHE UNIQUE SCENE BLANC 130X230", 50),
      ],
    });

    expect(result.parsed.lineItems).toEqual(parsed.lineItems);
    expect(result.parsed.planningSummaryRecovery).toMatchObject({
      status: "none",
      ambiguousCandidateCount: 1,
      recoveredCount: 0,
    });
    expect(result.validation.warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: "lineItems" })]),
    );
  });

  it("keeps an explicit warning when evidence-backed recovery is only partial", async () => {
    const parsed = makeParsed();
    const result = await recoverPlanningTotalsBoxLines({
      pdfBuffer: Buffer.from("pdf"),
      fileName: "partial.pdf",
      parsed,
      validation: validateExtraction(parsed),
      recoverCandidates: async () => [
        candidate("Printed retained option", 200),
      ],
    });

    expect(result.parsed.planningSummaryRecovery).toMatchObject({
      status: "partial",
      recoveredCount: 1,
      finalLineItemsTotal: 300,
    });
    expect(result.validation.confidenceScore).toBeLessThan(80);
    expect(result.validation.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "lineItems",
          actual: 300,
          expected: 500,
          message: expect.stringContaining("did not fully reconcile"),
        }),
      ]),
    );
  });

  it("rejects TTC, unsupported, duplicate, and overshooting candidates", async () => {
    const parsed = makeParsed({
      amountHt: 200,
      amountTtc: 240,
      tvaAmount: 40,
      lineItems: [{ description: "Base", total: 100 }],
    });
    const result = await recoverPlanningTotalsBoxLines({
      pdfBuffer: Buffer.from("pdf"),
      fileName: "unsafe-candidates.pdf",
      parsed,
      validation: validateExtraction(parsed),
      recoverCandidates: async () => [
        candidate("TTC option", 100, { amountBasis: "TTC" }),
        candidate("Excluded option", 100, { includedInTotal: false }),
        candidate("No evidence", 100, { evidenceText: "" }),
        candidate("Overshoots", 101),
      ],
    });

    expect(result.parsed.lineItems).toEqual(parsed.lineItems);
    expect(result.parsed.planningSummaryRecovery).toMatchObject({
      status: "none",
      candidateCount: 4,
      recoveredCount: 0,
    });
    expect(result.validation.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "lineItems",
          message: expect.stringContaining("found no additional evidence-backed"),
        }),
      ]),
    );
  });

  it("flags a one-cent Planning mismatch even though the shared validator tolerance accepts it", async () => {
    const parsed = makeParsed({
      amountHt: 100.01,
      amountTtc: 120.01,
      tvaAmount: 20,
      lineItems: [{ description: "Rounded row", total: 100 }],
    });
    const initialValidation = validateExtraction(parsed);
    expect(initialValidation.warnings.some((warning) => warning.field === "lineItems")).toBe(false);

    const result = await recoverPlanningTotalsBoxLines({
      pdfBuffer: Buffer.from("pdf"),
      fileName: "rounding-edge.pdf",
      parsed,
      validation: initialValidation,
      recoverCandidates: async () => [],
    });

    expect(result.parsed.planningSummaryRecovery).toMatchObject({
      status: "none",
      difference: 0.01,
    });
    expect(result.validation.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "lineItems",
          actual: 100,
          expected: 100.01,
        }),
      ]),
    );
  });

  it("preserves a verification warning when the targeted AI pass fails", async () => {
    const parsed = makeParsed();
    const result = await recoverPlanningTotalsBoxLines({
      pdfBuffer: Buffer.from("pdf"),
      fileName: "recovery-failure.pdf",
      parsed,
      validation: validateExtraction(parsed),
      recoverCandidates: async () => {
        throw new Error("provider diagnostic that must not become persisted data");
      },
    });

    expect(result.parsed.planningSummaryRecovery).toMatchObject({
      status: "failed",
      recoveredCount: 0,
    });
    expect(JSON.stringify(result)).not.toContain("provider diagnostic");
    expect(result.validation.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "lineItems",
          message: expect.stringContaining("could not complete"),
        }),
      ]),
    );
  });

  it("ignores malformed candidate entries without aborting the Planning import", async () => {
    const parsed = makeParsed();
    const result = await recoverPlanningTotalsBoxLines({
      pdfBuffer: Buffer.from("pdf"),
      fileName: "malformed-candidates.pdf",
      parsed,
      validation: validateExtraction(parsed),
      recoverCandidates: async () => [null, "bad", 42] as unknown as PlanningSummaryLineCandidate[],
    });

    expect(result.parsed.planningSummaryRecovery).toMatchObject({
      status: "none",
      candidateCount: 3,
      recoveredCount: 0,
    });
    expect(result.validation.warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: "lineItems" })]),
    );
  });

  it("does not run quotation-option recovery for non-quotation documents", async () => {
    const parsed = makeParsed({ documentType: "invoice" });
    const validation = validateExtraction(parsed);
    const recoverCandidates = vi.fn();

    const result = await recoverPlanningTotalsBoxLines({
      pdfBuffer: Buffer.from("pdf"),
      fileName: "invoice.pdf",
      parsed,
      validation,
      recoverCandidates,
    });

    expect(recoverCandidates).not.toHaveBeenCalled();
    expect(result).toEqual({ parsed, validation });
  });
});