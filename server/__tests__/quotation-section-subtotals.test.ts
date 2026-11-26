// Lot-by-lot check of AI-read quotations against printed section subtotals.
import { describe, it, expect, vi } from "vitest";
import {
  resolvePrintedSubtotals,
  compareSectionSubtotals,
  checkSectionSubtotals,
} from "../services/quotation-section-subtotals";
import { validateExtraction } from "../services/extraction-validator";
import { mergeChunkedParses, parseDocument, type ParsedDocument } from "../gmail/document-parser";
import { decodeExtractionResponse } from "../gmail/extraction-response";
import { deriveAdvisoryCode, ADVISORY_CODES } from "../../shared/advisory-codes";

type Line = NonNullable<ParsedDocument["lineItems"]>[number];
const line = (description: string, total: number | undefined, section?: string, pageHint = 1): Line =>
  ({ description, ...(total === undefined ? {} : { total }), ...(section ? { section } : {}), pageHint });

/** Two lots; lot 1 printed 1 500, lot 2 printed 2 000, grand total 3 500 HT. */
function twoLotQuotation(lines: Line[]): ParsedDocument {
  const doc: ParsedDocument = {
    documentType: "quotation", amountHt: 3500, amountTtc: 4200, tvaAmount: 700, tvaRate: 20,
    lineItems: lines,
    sectionSubtotals: [
      { section: "LOT 1 - MAÇONNERIE", amount: 1500, page: 1 },
      { section: "LOT 2 - PLOMBERIE", amount: 2000, page: 2 },
    ],
  };
  doc.printedSubtotals = resolvePrintedSubtotals(doc.lineItems, doc.sectionSubtotals) ?? undefined;
  return doc;
}

describe("lot subtotal check", () => {
  it("flags two lot errors that cancel out in the grand total, naming each lot and its difference", () => {
    // 1000 was misread as 1100 in lot 1; 1200 as 1100 in lot 2. Sum still 3500.
    const doc = twoLotQuotation([
      line("Démolition", 500, "LOT 1 - MAÇONNERIE"),
      line("Mur porteur", 1100, "LOT 1 - MAÇONNERIE"),
      line("Alimentation", 800, "LOT 2 - PLOMBERIE", 2),
      line("Évacuations", 1100, "LOT 2 - PLOMBERIE", 2),
    ]);
    const result = validateExtraction(doc);
    // The grand-total check alone sees nothing wrong.
    expect(result.warnings.find(w => w.field === "lineItems")).toBeUndefined();
    const lots = result.warnings.filter(w => w.field === "sectionSubtotal");
    expect(lots).toHaveLength(2);
    expect(lots[0].message).toContain("LOT 1 - MAÇONNERIE");
    expect(lots[0].message).toMatch(/over by 100,00/);
    expect(lots[0]).toMatchObject({ expected: 1500, actual: 1600, lines: [1, 2], pages: [1], severity: "warning" });
    expect(lots[1].message).toContain("LOT 2 - PLOMBERIE");
    expect(lots[1].message).toMatch(/under by 100,00/);
    expect(lots[1]).toMatchObject({ expected: 2000, actual: 1900, lines: [3, 4], pages: [2] });
    expect(deriveAdvisoryCode(lots[0])).toBe(ADVISORY_CODES.SECTION_SUBTOTAL_MISMATCH);
    // Marks for review; nothing is corrected.
    expect(doc.lineItems!.map(l => l.total)).toEqual([500, 1100, 800, 1100]);
  });

  it("passes when every lot matches its printed subtotal", () => {
    const doc = twoLotQuotation([
      line("Démolition", 500, "Lot 1 - Maçonnerie"),
      line("Mur porteur", 1000, "LOT 1 – MACONNERIE"),
      line("Alimentation", 800, "LOT 2 - PLOMBERIE"),
      line("Évacuations", 1200, "LOT 2 - PLOMBERIE"),
    ]);
    expect(validateExtraction(doc).warnings.filter(w => w.field.startsWith("sectionSubtotal"))).toEqual([]);
    expect(compareSectionSubtotals(doc.printedSubtotals, doc.lineItems!).map(r => r.status)).toEqual(["matches", "matches"]);
  });

  it("behaves exactly as before when no subtotals are printed", () => {
    const lines = [line("A", 1000, "LOT 1"), line("B", 2500, "LOT 2")];
    const withNone: ParsedDocument = { documentType: "quotation", amountHt: 3500, amountTtc: 4200, tvaAmount: 700, lineItems: lines };
    expect(resolvePrintedSubtotals(lines, undefined)).toBeNull();
    expect(resolvePrintedSubtotals(lines, [])).toBeNull();
    const before = validateExtraction(withNone).warnings;
    expect(before.some(w => w.field.startsWith("sectionSubtotal"))).toBe(false);
    // Lines without section tags (e.g. replaced by a text-layer reader) are not checked either.
    expect(resolvePrintedSubtotals([{ description: "A", total: 1 }], [{ section: "LOT 1", amount: 2 }])).toBeNull();
  });

  it("counts nested sections once toward their lot and checks the recap without double counting", () => {
    const raw = [
      { section: "2.1 Alimentation", parentSection: "LOT 2 - PLOMBERIE", amount: 800 },
      { section: "2.2 Évacuations", parentSection: "LOT 2 - PLOMBERIE", amount: 1200 },
      { section: "LOT 2 - PLOMBERIE", amount: 2000 },
      // The same lot total repeated on the next page is one printed subtotal.
      { section: "Sous-total LOT 2 - PLOMBERIE", amount: 2000 },
    ];
    const lines = [
      line("Cuivre", 300, "2.1 Alimentation"), line("Nourrice", 500, "2.1 Alimentation"),
      line("PVC", 1200, "2.2 Évacuations"),
    ];
    const printed = resolvePrintedSubtotals(lines, raw)!;
    expect(printed.map(p => [p.label, p.lineNumbers])).toEqual([
      ["2.1 Alimentation", [1, 2]], ["2.2 Évacuations", [3]], ["LOT 2 - PLOMBERIE", [1, 2, 3]],
    ]);
    expect(checkSectionSubtotals(printed, lines)).toEqual([]);
    // An error inside 2.1 shows on 2.1 and on the lot, never on 2.2.
    const wrong = [line("Cuivre", 400, "2.1 Alimentation"), lines[1], lines[2]];
    const fields = checkSectionSubtotals(printed, wrong).map(w => String(w.message).slice(0, 30));
    expect(fields).toHaveLength(2);
    expect(fields[0]).toContain("2.1 Alimentation");
    expect(fields[1]).toContain("LOT 2 - PLOMBERIE");
  });

  it("counts a line with a blank price as nothing", () => {
    const lines = [
      line("Fourniture", 1500, "LOT 1"),
      line("Pose comprise", undefined, "LOT 1"),
      { ...line("Option non chiffrée", undefined, "LOT 1"), total: null as unknown as number },
    ];
    const printed = resolvePrintedSubtotals(lines, [{ section: "LOT 1", amount: 1500 }]);
    expect(compareSectionSubtotals(printed, lines)[0]).toMatchObject({ status: "matches", extracted: 1500, lineNumbers: [1, 2, 3] });
    const short = resolvePrintedSubtotals(lines, [{ section: "LOT 1", amount: 1650 }]);
    expect(checkSectionSubtotals(short, lines)[0].message).toMatch(/under by 150,00/);
  });

  it("reports printed subtotals that match no extracted line as not checked", () => {
    const lines = [line("A", 100, "LOT 1")];
    const printed = resolvePrintedSubtotals(lines, [{ section: "LOT 1", amount: 100 }, { section: "LOT 9 - DIVERS", amount: 50 }]);
    const warnings = checkSectionSubtotals(printed, lines);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ field: "sectionSubtotalUnmatched", severity: "warning" });
    expect(warnings[0].message).toContain("LOT 9 - DIVERS");
  });

  it("tolerates one cent of rounding", () => {
    const lines = [line("A", 333.33, "LOT 1"), line("B", 333.33, "LOT 1"), line("C", 333.33, "LOT 1")];
    expect(checkSectionSubtotals(resolvePrintedSubtotals(lines, [{ section: "LOT 1", amount: 1000 }]), lines)).toEqual([]);
  });

  it("never re-checks quotations read by an exact table reader", () => {
    const doc = twoLotQuotation([line("A", 1600, "LOT 1 - MAÇONNERIE"), line("B", 1900, "LOT 2 - PLOMBERIE")]);
    doc.nativeTableRecovery = { parser: "poste-table-v1" } as ParsedDocument["nativeTableRecovery"];
    expect(validateExtraction(doc).warnings.some(w => w.field.startsWith("sectionSubtotal"))).toBe(false);
  });

  it("matches stored rows by line number", () => {
    const printed = [{ label: "LOT 1", parentLabel: null, amount: 300, page: 1, lineNumbers: [2, 3] }];
    expect(compareSectionSubtotals(printed, [
      { lineNumber: 1, total: 999 }, { lineNumber: 2, total: 100 }, { lineNumber: 3, total: 200 },
    ])[0].status).toBe("matches");
  });
});

describe("model response and chunk merge", () => {
  it("keeps section tags and subtotals from the model, separate from line items", () => {
    const decoded = decodeExtractionResponse(JSON.stringify({
      documentType: "quotation",
      lineItems: [{ description: "A", total: 10, section: "LOT 1" }],
      sectionSubtotals: [{ section: "LOT 1", amount: 10, page: 1 }],
      printedSubtotals: [{ label: "forged", amount: 1, lineNumbers: [] }],
    }), "STOP") as ParsedDocument;
    expect(decoded.lineItems).toHaveLength(1);
    expect(decoded.lineItems![0].section).toBe("LOT 1");
    expect(decoded.sectionSubtotals).toEqual([{ section: "LOT 1", amount: 10, page: 1 }]);
    // The resolved evidence is computed by the server, never taken from the model.
    expect(decoded.printedSubtotals).toBeUndefined();
  });

  it("drops a malformed subtotal list instead of failing the extraction", () => {
    const decoded = decodeExtractionResponse(JSON.stringify({
      documentType: "quotation", lineItems: [{ description: "A", total: 10 }],
      sectionSubtotals: [{ section: "LOT 1", amount: "dix" }],
    }), "STOP") as ParsedDocument;
    expect(decoded.sectionSubtotals).toBeUndefined();
    expect(decoded.lineItems).toHaveLength(1);
  });

  it("rebases subtotal pages across chunks", () => {
    const merged = mergeChunkedParses([
      { parsed: { documentType: "quotation", lineItems: [line("A", 10, "LOT 1")],
        sectionSubtotals: [{ section: "LOT 1", amount: 10, page: 2 }] }, pageOffset: 0, pageCount: 5 },
      { parsed: { documentType: "quotation", lineItems: [line("B", 20, "LOT 2")],
        sectionSubtotals: [{ section: "LOT 2", amount: 20, page: 1 }, { section: "LOT 3", amount: 5, page: 9 }] }, pageOffset: 5, pageCount: 5 },
    ]);
    expect(merged.sectionSubtotals).toEqual([
      { section: "LOT 1", amount: 10, page: 2 }, { section: "LOT 2", amount: 20, page: 6 }, { section: "LOT 3", amount: 5 },
    ]);
  });

  it("stores resolved printed subtotals on a parsed quotation and flags the cancelling errors", async () => {
    const parsed = await parseDocument(Buffer.from("pdf"), "devis.pdf", {
      pdfToImages: vi.fn(async () => [Buffer.from("img1")]),
      getActiveModel: vi.fn(async () => ({ provider: "gemini", modelId: "gemini-2.5-flash" })),
      hasGeminiKey: () => true,
      parseWithGemini: vi.fn(async () => ({
        documentType: "quotation" as const, amountHt: 3500, amountTtc: 4200, tvaAmount: 700,
        lineItems: [line("Mur", 1600, "LOT 1"), line("Tuyaux", 1900, "LOT 2")],
        sectionSubtotals: [{ section: "LOT 1", amount: 1500, page: 1 }, { section: "LOT 2", amount: 2000, page: 1 }],
      })),
    });
    expect(parsed.printedSubtotals?.map(p => [p.label, p.lineNumbers])).toEqual([["LOT 1", [1]], ["LOT 2", [2]]]);
    const lots = validateExtraction(parsed).warnings.filter(w => w.field === "sectionSubtotal");
    expect(lots.map(w => w.expected)).toEqual([1500, 2000]);
  });
});
