import { describe, expect, it, vi } from "vitest";
import { roundCurrency } from "../../shared/financial-utils";
import type {
  ParsedDocument,
  PlanningSummaryExcludedGroupCandidate,
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

function excludedGroup(
  description: string,
  totalHt: number,
  lineItemIndexes: number[],
  overrides: Partial<PlanningSummaryExcludedGroupCandidate> = {},
): PlanningSummaryExcludedGroupCandidate {
  return {
    description,
    totalHt,
    evidenceText: "OPTION ALTERNATIVE — OPTIONS RETENUES DANS LE TOTAL",
    excludedFromTotal: true,
    amountBasis: "HT",
    lineItemIndexes,
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
        lineItems: [
          {
            index: 1,
            description: "Previously extracted pages and body rows",
            totalHt: 10_000,
          },
          {
            index: 2,
            description: "Final-page main table rows",
            totalHt: 908,
          },
        ],
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

  it("reconciles Richardson retained groups, excludes alternatives, and corrects the totals box", async () => {
    const parsed = makeParsed({
      amountHt: 17_463.97,
      amountTtc: 20_957.63,
      tvaAmount: 3_492.80,
      tvaRate: 20,
      lineItems: [
        { description: "Base quotation rows", total: 10_908 },
        { description: "Unretained shower-tray alternative", total: 1_537.25 },
        { description: "Unretained mixer alternative", total: 1_503.20 },
        { description: "PROGRAM 200X50 BLANC", total: 1_455.35 },
        { description: "CUVES SUPPL S1", total: 174.85 },
        { description: "BONDE FIXE BLANC SCENE", total: 63.70 },
        { description: "DOUCHE ENCASTRÉ MOBIL INOX BROSSÉ", total: 1_646.71 },
        { description: "REC SCENE 130X230 BLANC", total: 3_215.26 },
      ],
    });
    expect(roundCurrency(parsed.lineItems!.reduce((sum, item) => sum + item.total!, 0)))
      .toBe(20_504.32);

    const result = await recoverPlanningTotalsBoxLines({
      pdfBuffer: Buffer.from("pdf"),
      fileName: "PROPOSITION_N_007-2046.pdf",
      parsed,
      validation: validateExtraction(parsed),
      recoverCandidates: async () => ({
        lines: [
          candidate("HAUTEUR DE RETOMBÉE 40 CM - SANS TROP PLEIN", 1_693.90, {
            matchedLineItemIndexes: [4, 5, 6],
            pageHint: 3,
          }),
          candidate("DOUCHE ENCASTRÉ MOBIL INOX BROSSÉ", 1_646.71, {
            matchedLineItemIndexes: [7],
            pageHint: 3,
          }),
          candidate("RECEVEUR DE DOUCHE UNIQUE SCENE BLANC 130X230", 3_215.26, {
            matchedLineItemIndexes: [8],
            pageHint: 3,
          }),
        ],
        excludedGroups: [
          excludedGroup("ALTERNATIVES NON RETENUES", 3_040.45, [2, 3], {
            pageHint: 3,
          }),
        ],
        totals: {
          amountHt: 17_463.87,
          preTaxChargesHt: 0.99,
          tvaAmount: 3_492.97,
          amountTtc: 20_957.83,
          tvaRate: 20,
          evidenceText:
            "MONTANT H.T 17 463,87; FRAIS FIXES 0,99; TVA 20,00 % 3 492,97; MONTANT TTC 20 957,83",
          pageHint: 3,
        },
      }),
    });

    expect(result.parsed).toMatchObject({
      amountHt: 17_463.87,
      preTaxChargesHt: 0.99,
      tvaAmount: 3_492.97,
      amountTtc: 20_957.83,
    });
    expect(result.parsed.lineItems?.map((item) => item.description)).toEqual([
      "Base quotation rows",
      "PROGRAM 200X50 BLANC",
      "CUVES SUPPL S1",
      "BONDE FIXE BLANC SCENE",
      "DOUCHE ENCASTRÉ MOBIL INOX BROSSÉ",
      "REC SCENE 130X230 BLANC",
    ]);
    expect(roundCurrency(result.parsed.lineItems!.reduce((sum, item) => sum + item.total!, 0)))
      .toBe(17_463.87);
    expect(result.parsed.planningSummaryRecovery).toMatchObject({
      status: "reconciled",
      originalExpectedHt: 17_463.97,
      expectedHt: 17_463.87,
      initialLineItemsTotal: 20_504.32,
      difference: -3_040.45,
      candidateCount: 4,
      recoveredCount: 0,
      matchedRetainedCount: 3,
      excludedCount: 2,
      excludedTotal: 3_040.45,
      finalLineItemsTotal: 17_463.87,
      excludedEvidence: [
        expect.objectContaining({
          lineItemIndexes: [2, 3],
          totalHt: 3_040.45,
        }),
      ],
      correctedTotals: expect.objectContaining({
        amountHt: 17_463.87,
        preTaxChargesHt: 0.99,
        tvaAmount: 3_492.97,
        amountTtc: 20_957.83,
      }),
    });
    expect(result.validation.warnings).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "lineItems" }),
        expect.objectContaining({ field: "tvaAmount" }),
      ]),
    );
    expect(parsed.lineItems).toHaveLength(8);
  });

  it("does not exclude any rows unless the complete evidence-backed set reconciles HT", async () => {
    const parsed = makeParsed({
      amountHt: 100,
      amountTtc: 120,
      tvaAmount: 20,
      lineItems: [
        { description: "Retained base", total: 70 },
        { description: "Possible alternative", total: 40 },
      ],
    });
    const result = await recoverPlanningTotalsBoxLines({
      pdfBuffer: Buffer.from("pdf"),
      fileName: "ambiguous-overage.pdf",
      parsed,
      validation: validateExtraction(parsed),
      recoverCandidates: async () => ({
        lines: [
          candidate("Retained base", 70, { matchedLineItemIndexes: [1] }),
        ],
        excludedGroups: [
          excludedGroup("Possible alternative", 40, [2]),
        ],
      }),
    });

    expect(result.parsed.lineItems).toEqual(parsed.lineItems);
    expect(result.parsed.planningSummaryRecovery).toMatchObject({
      status: "none",
      matchedRetainedCount: 1,
      excludedCount: 0,
      excludedTotal: 0,
      finalLineItemsTotal: 110,
    });
    expect(result.validation.warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: "lineItems" })]),
    );
  });

  it("ignores an arithmetically inconsistent totals-box candidate", async () => {
    const parsed = makeParsed({
      amountHt: 100,
      amountTtc: 120,
      tvaAmount: 20,
      lineItems: [{ description: "Base", total: 90 }],
    });
    const result = await recoverPlanningTotalsBoxLines({
      pdfBuffer: Buffer.from("pdf"),
      fileName: "unsafe-totals.pdf",
      parsed,
      validation: validateExtraction(parsed),
      recoverCandidates: async () => ({
        lines: [],
        excludedGroups: [],
        totals: {
          amountHt: 100,
          preTaxChargesHt: 1,
          tvaAmount: 20,
          amountTtc: 120,
          evidenceText: "MONTANT H.T; FRAIS; TVA; TTC",
        },
      }),
    });

    expect(result.parsed.amountHt).toBe(100);
    expect(result.parsed.preTaxChargesHt).toBeUndefined();
    expect(result.parsed.planningSummaryRecovery).toMatchObject({
      status: "none",
      ambiguousCandidateCount: 1,
    });
  });

  it("rechecks arithmetically exact quotations and recovers separate pre-tax charges", async () => {
    const parsed = makeParsed({
      amountHt: 100,
      amountTtc: 121.20,
      tvaAmount: undefined,
      lineItems: [{ description: "Retained base", total: 100 }],
    });
    const initialValidation = validateExtraction(parsed);
    expect(initialValidation.correctedValues.tvaAmount).toBe(21.20);
    const recoverCandidates = vi.fn(async () => ({
      lines: [
        candidate("Retained base", 100, { matchedLineItemIndexes: [1] }),
      ],
      excludedGroups: [],
      totals: {
        amountHt: 100,
        preTaxChargesHt: 1,
        tvaAmount: 20.20,
        amountTtc: 121.20,
        tvaRate: 20,
        evidenceText: "MONTANT H.T 100; FRAIS FIXES 1; TVA 20,20; TTC 121,20",
      },
    }));

    const result = await recoverPlanningTotalsBoxLines({
      pdfBuffer: Buffer.from("pdf"),
      fileName: "exact-lines-with-charge.pdf",
      parsed,
      validation: initialValidation,
      recoverCandidates,
    });

    expect(recoverCandidates).toHaveBeenCalledOnce();
    expect(result.parsed).toMatchObject({
      amountHt: 100,
      preTaxChargesHt: 1,
      tvaAmount: 20.20,
      amountTtc: 121.20,
      planningSummaryRecovery: {
        status: "reconciled",
        matchedRetainedCount: 1,
        finalLineItemsTotal: 100,
      },
    });
    expect(result.validation.warnings).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "lineItems" }),
        expect.objectContaining({ field: "tvaAmount" }),
      ]),
    );
  });

  it("keeps human review when unsafe evidence accompanies an arithmetically exact recovery", async () => {
    const parsed = makeParsed({
      amountHt: 200,
      amountTtc: 240,
      tvaAmount: 40,
      lineItems: [{ description: "Base", total: 90 }],
    });
    const result = await recoverPlanningTotalsBoxLines({
      pdfBuffer: Buffer.from("pdf"),
      fileName: "conflicting-evidence.pdf",
      parsed,
      validation: validateExtraction(parsed),
      recoverCandidates: async () => ({
        lines: [candidate("Printed retained option", 110)],
        excludedGroups: [],
        unsafeEvidenceCount: 1,
      }),
    });

    expect(result.parsed.planningSummaryRecovery).toMatchObject({
      status: "partial",
      ambiguousCandidateCount: 1,
      recoveredCount: 1,
      finalLineItemsTotal: 200,
    });
    expect(result.validation.confidenceScore).toBeLessThan(80);
    expect(result.validation.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "lineItems",
          actual: 200,
          expected: 200,
          message: expect.stringContaining("matches the quotation HT total arithmetically"),
        }),
      ]),
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
          message: expect.stringContaining("could not safely reconcile"),
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
          message: expect.stringContaining("found no unambiguous evidence-backed"),
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