import { describe, it, expect } from "vitest";
import { illustratedPriceRows, acceptIllustratedRecovery } from "../services/illustrated-quotation";
import type { ParsedDocument } from "../gmail/document-parser";
import { parseDocument } from "../gmail/document-parser";
import { validateExtraction } from "../services/extraction-validator";

const page = (price: string, vat = "5,50") => `La fourniture et pose d'une menuiserie :   ${price}  1  ${price}  ${vat}\n- Composé de`;
const texts = [page("100,00"), page("200,00", "20,00"), page("300,00")];
const rows = illustratedPriceRows(texts);
const baseline: ParsedDocument = { documentType: "quotation", amountHt: 600, amountTtc: 661.5 };
const candidate: ParsedDocument = {
  ...baseline,
  lineItems: rows.map((r, i) => ({
    description: `Product ${i}: printed dimensions 800 x 1100 mm; finish grey; glazing specification retained.`,
    quantity: 1, unitPrice: r.unitPrice, total: r.total, pageHint: r.page + 1,
    bbox: { x: 0, y: 0, w: 1, h: 1 },
  })),
};
describe("illustrated quotation recovery", () => {
  it("transcribes all source rows with mixed VAT without guessing taxes", () => {
    expect(rows.map(r => r.total)).toEqual([100, 200, 300]);
    expect(baseline.amountTtc).toBe(661.5);
  });
  it("keeps continuation specifications but anchors each item to its price page", () => {
    const result = acceptIllustratedRecovery(baseline, candidate, rows)!;
    expect(result.map(r => r.pageHint)).toEqual([1, 2, 3]);
    expect(result[0].bbox).toBeUndefined();
    expect(result[0].description).toContain("glazing");
  });
  it("does not trigger on ordinary tables or incomplete block transcription", () => {
    expect(illustratedPriceRows(["Item 1 100,00 1 100,00 20,00"])).toEqual([]);
    expect(illustratedPriceRows([...texts, "Fourniture et pose : unreadable"])).toEqual([]);
  });
  it("rejects missing rows, price shifts, guessed totals and options not reconciling", () => {
    expect(acceptIllustratedRecovery(baseline, { ...candidate, lineItems: candidate.lineItems!.slice(1) }, rows)).toBeNull();
    expect(acceptIllustratedRecovery(baseline, { ...candidate, lineItems: [...candidate.lineItems!].reverse() }, rows)).toBeNull();
    expect(acceptIllustratedRecovery({ ...baseline, amountHt: undefined }, candidate, rows)).toBeNull();
    expect(acceptIllustratedRecovery({ ...baseline, amountHt: 500 }, { ...candidate, amountHt: 500 }, rows)).toBeNull();
  });
  it("shared parser recovers lines without replacing header finances and emits a review advisory", async () => {
    const result = await parseDocument(Buffer.from("test"), "illustrated.pdf", {
      pdfToImagesWithCoverage: async () => ({ images: texts.map(() => Buffer.from("image")), pdfPageCount: 3 }),
      getPageTexts: async () => texts,
      getActiveModel: async () => ({ provider: "gemini", modelId: "test" }),
      parseWithGemini: async () => ({ ...baseline, lineItems: candidate.lineItems!.slice(0, 1) }),
      recoverIllustratedPdf: async () => ({ ...candidate, amountTtc: 999 }),
      hasGeminiKey: () => true,
    });
    expect(result.lineItems).toHaveLength(3);
    expect(result.amountTtc).toBe(baseline.amountTtc);
    expect(result.illustratedRecovery?.status).toBe("recovered");
    expect(validateExtraction(result).warnings.some(w => w.field === "illustrated_quotation_review")).toBe(true);
  });
  it("keeps the baseline and visible review requirement when recovery fails", async () => {
    const result = await parseDocument(Buffer.from("test"), "illustrated.pdf", {
      pdfToImagesWithCoverage: async () => ({ images: texts.map(() => Buffer.from("image")), pdfPageCount: 3 }),
      getPageTexts: async () => texts,
      getActiveModel: async () => ({ provider: "gemini", modelId: "test" }),
      parseWithGemini: async () => ({ ...baseline, lineItems: candidate.lineItems!.slice(0, 1) }),
      recoverIllustratedPdf: async () => { throw new Error("timeout"); },
      hasGeminiKey: () => true,
    });
    expect(result.lineItems).toHaveLength(1);
    expect(result.illustratedRecovery?.status).toBe("review_required");
  });
});