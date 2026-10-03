import { describe, it, expect, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { supplierPages, supplierPdf } from "./fixtures/illustrated-supplier";
import { illustratedEvidence, acceptIllustratedRecovery } from "../services/illustrated-quotation";
import { parseDocument, type ParsedDocument } from "../gmail/document-parser";

const pages = supplierPages();
const base: ParsedDocument = {
  documentType: "quotation", amountHt: 500, amountTtc: 600,
  lineItems: [{ description: "Original baseline description kept verbatim", total: 500 }],
};
const candidate: ParsedDocument = {
  ...base,
  lineItems: [100, 100, 300].map((total, i) => ({
    description: `WIN-0${i + 1}: dimensions 800 x 1100 mm, vitrage isolant, finition grise et poignée blanche.`,
    quantity: 1, unitPrice: total, total, pageHint: 99,
  })),
};
async function parse(texts = pages, recover = vi.fn(async () => structuredClone(candidate)), opts: {
  provider?: "gemini" | "openai"; bytes?: number; images?: number; baseline?: ParsedDocument;
} = {}) {
  const result = await parseDocument(Buffer.alloc(opts.bytes ?? 4), "disposable.pdf", {
    pdfToImagesWithCoverage: async () => ({
      images: Array.from({ length: opts.images ?? texts.length }, () => Buffer.from("image")),
      pdfPageCount: opts.images ?? texts.length,
    }),
    getPageTexts: async () => texts,
    getActiveModel: async () => ({ provider: opts.provider ?? "gemini", modelId: "test" }),
    parseWithGemini: async () => structuredClone(opts.baseline ?? base),
    parseWithOpenAI: async () => structuredClone(opts.baseline ?? base),
    recoverIllustratedPdf: recover,
    hasGeminiKey: () => false,
  });
  return { result, recover };
}

describe("reference-led illustrated supplier layouts", () => {
  it.each([false, true])("reads a real disposable illustrated PDF (price-first=%s)", async priceFirst => {
    const dir = mkdtempSync(join(tmpdir(), "supplier-regression-"));
    try {
      const path = join(dir, "synthetic.pdf");
      writeFileSync(path, await supplierPdf(supplierPages(priceFirst)));
      const text = execFileSync("pdftotext", ["-layout", path, "-"], { encoding: "utf8" });
      const texts = text.split("\f");
      if (!texts.at(-1)?.trim()) texts.pop();
      const evidence = illustratedEvidence(texts);
      expect(evidence.rows.map(r => [r.reference, r.total, r.page])).toEqual([
        ["WIN-01", 100, 1], ["WIN-02", 100, 3], ["WIN-03", 300, 4],
      ]);
      const recovered = acceptIllustratedRecovery(base, candidate, evidence.rows)!;
      expect(recovered.map(r => r.pageHint)).toEqual([1, 3, 4]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("rejects equal-price identity swaps, duplicate references and merged references", () => {
    const rows = illustratedEvidence(pages).rows;
    const swapped = structuredClone(candidate);
    [swapped.lineItems![0], swapped.lineItems![1]] = [swapped.lineItems![1], swapped.lineItems![0]];
    expect(acceptIllustratedRecovery(base, swapped, rows)).toBeNull();
    swapped.lineItems![0].description += " WIN-01";
    expect(acceptIllustratedRecovery(base, swapped, rows)).toBeNull();
    expect(illustratedEvidence(pages.map(t => t.replace("WIN-02", "WIN-01"))).rows).toEqual([]);
  });
  it.each([
    ["missing price", (t: string) => t.replace("Total HT : 100,00", "Total HT : unreadable")],
    ["extra charge", (t: string) => t + "\nLivraison : 10,00"],
    ["option", (t: string) => t + "\nOption non retenue : 100,00"],
    ["discount", (t: string) => t + "\nRemise : -10,00"],
    ["unknown continuation", (t: string) => t.replace("WIN-01 (suite)", "WIN-99 (suite)")],
  ])("preserves the baseline and makes zero calls for %s", async (_name, transform) => {
    const texts = pages.map(transform);
    const { result, recover } = await parse(texts);
    expect(recover).not.toHaveBeenCalled();
    expect(result.lineItems).toEqual(base.lineItems);
    expect(result.illustratedRecovery?.status).toBe("review_required");
  });
  it("uses exactly one bounded recovery and preserves header values and caller-owned data", async () => {
    const before = structuredClone(base);
    const { result, recover } = await parse();
    expect(recover).toHaveBeenCalledTimes(1);
    expect(result.illustratedRecovery?.status).toBe("recovered");
    expect(result.amountTtc).toBe(600);
    expect(base).toEqual(before);
  });
  it.each([
    { provider: "openai" as const },
    { bytes: 15 * 1024 * 1024 + 1 },
    { images: 21 },
    { baseline: { ...base, amountHt: 499 } },
    { baseline: { ...base, lineItems: [{ description: "Option retained by operator", total: 500 }] } },
  ])("does not call recovery when the provider, budget or source gate fails: %j", async opts => {
    const { result, recover } = await parse(pages, undefined, opts);
    expect(recover).not.toHaveBeenCalled();
    expect(result.illustratedRecovery?.status).toBe("review_required");
    // The baseline is parsed once per five-page chunk; recovery leaves all
    // those rows untouched rather than replacing them with the three products.
    if ("images" in opts) {
      expect(result.lineItems).toHaveLength(5);
      expect(result.lineItems?.every(l => l.description === base.lineItems![0].description)).toBe(true);
    } else {
      expect(result.lineItems).toEqual((opts.baseline ?? base).lineItems);
    }
  });
  it("keeps review visible after model failure or missing identity", async () => {
    const fail = vi.fn(async (): Promise<ParsedDocument> => { throw new Error("timeout"); });
    const failed = await parse(pages, fail);
    expect(fail).toHaveBeenCalledTimes(1);
    expect(failed.result.lineItems).toEqual(base.lineItems);
    const wrong = structuredClone(candidate);
    wrong.lineItems![0].description = wrong.lineItems![0].description.replace("WIN-01", "UNKNOWN");
    const rejected = await parse(pages, vi.fn(async () => wrong));
    expect(rejected.result.lineItems).toEqual(base.lineItems);
    expect(rejected.result.illustratedRecovery?.status).toBe("review_required");
  });
  it("does not treat ordinary reference tables as illustrated cards, or accept missing pages", () => {
    expect(illustratedEvidence(["Référence Quantité Prix HT\nA1 1 100,00"]).detected).toBe(false);
    expect(illustratedEvidence([...pages, null]).rows).toEqual([]);
  });
  it.each([
    "\nLivraison HT : 10 EUR\nAvoir HT : -10 EUR",
    "\nTransport : 10\nCrédit : -10",
    "\nExtra : 10 €\nCorrection : -10 €",
    "\nFrais : 10\nAvoir : -10",
    "\nManutention : 10\nDéduction : -10",
    "\nService spécial +10\nGeste commercial -10",
    "\nPersonnalisation 10 unités\nCompensation -10 unités",
  ])("never drops zero-net integer adjustments: %s", async adjustments => {
    const texts = [...pages];
    texts[3] += adjustments;
    const baseline = {
      ...base,
      lineItems: [...candidate.lineItems!,
        { description: "Livraison", total: 10 },
        { description: "Avoir", total: -10 }],
    };
    const { result, recover } = await parse(texts, undefined, { baseline });
    expect(recover).not.toHaveBeenCalled();
    expect(result.lineItems).toEqual(baseline.lineItems);
    expect(result.illustratedRecovery?.status).toBe("review_required");
  });
  it.each([
    "TOTAL GENERAL HT : 510,00",
    "",
    "TOTAL GENERAL HT : 500,00\nTOTAL GENERAL HT : 510,00",
    "TOTAL GENERAL HT : 500,00\nTOTAL GENERAL HT : 500,00",
    "TOTAL GENERAL HT : unreadable",
    "TOTAL GENERAL HT : 500,00\nTOTAL GENERAL HT : unreadable",
    "TOTAL GENERAL HT : unreadable\nTOTAL GENERAL HT : 500,00",
  ])("requires one independently printed matching HT: %s", async total => {
    const texts = pages.map(p => p.replace("TOTAL GENERAL HT : 500,00", total));
    const { result, recover } = await parse(texts);
    expect(recover).not.toHaveBeenCalled();
    expect(result.lineItems).toEqual(base.lineItems);
    expect(result.illustratedRecovery?.status).toBe("review_required");
  });
});