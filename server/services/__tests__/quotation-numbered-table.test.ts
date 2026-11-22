import { describe, expect, it } from "vitest";
import { recoverNumberedTable } from "../quotation-numbered-table";
import { collectPricedEvidence, pricedRowsDigest } from "../quotation-priced-evidence";
import { createHash } from "node:crypto";
import type { ParsedDocument } from "../../gmail/document-parser";

const header = "N°  Désignation  Un Quantité  Prix unit.  Montant H.T.";
const pages = [
  `${header}
1  LOT WORK
1.1  Installation beginning  u  2,000  10,00  20,00
©Sage Page 1`,
  `${header}
continued on second page
1.2  Electricity by another trade  u  3,000
Sous-total LOT WORK  20,00
2  LOT SERVICES
2.1  Plumbing
2.1.1  Connection  u  1,000  30,00  30,00
Sous-total Plumbing  30,00
Sous-total LOT SERVICES  30,00
©Sage Page 2`,
  `Total H.T.  50,00
Total T.V.A. 10,00 %  5,00
Total T.T.C.  55,00
N°  Récapitulatif  Quantité  Prix U.  Montant H.T.
1  LOT WORK  1,000  20,00  20,00
2  LOT SERVICES  1,000  30,00  30,00
2.1  Plumbing  1,000  30,00  30,00
©Sage Page 3`,
  "Réf. Devis : TEST\n©Sage Page 4",
];
describe("numbered native quotation tables", () => {
  it("preserves cross-page wording and blank prices, excludes nested recap duplication", () => {
    const r = recoverNumberedTable(pages)!;
    expect(r).not.toBeNull();
    expect(r.rows).toHaveLength(3);
    expect(r.amountHt).toBe(50);
    expect(r.amountTtc).toBe(55);
    expect(r.rows[0].description).toContain("beginning continued on second page");
    expect(r.evidence[0].pages).toEqual([1, 2]);
    expect(r.rows[1].total).toBeUndefined();
    const pdf = Buffer.from("test");
    const parsed: ParsedDocument = { documentType: "quotation", lineItems: r.rows,
      nativeTableRecovery: { ...r, parser: "numbered-table-v1", initialLineItems: [],
        sourceDigest: createHash("sha256").update(pdf).digest("hex") } };
    expect(collectPricedEvidence(parsed, pdf).issues).toEqual([]);
    expect(collectPricedEvidence(parsed, pdf).rowsDigest).toBe(
      pricedRowsDigest(r.rows.map(row => ({ ...row, total: row.total ?? 0 }))));
    parsed.lineItems![0].total = 21;
    expect(collectPricedEvidence(parsed, pdf).issues.length).toBeGreaterThan(0);
  });
  it.each([
    ["missing row", "1.1  Installation beginning  u  2,000  10,00  20,00", ""],
    ["wrong product", "2,000  10,00  20,00", "3,000  10,00  20,00"],
    ["wrong subtotal", "Sous-total LOT WORK  20,00", "Sous-total LOT WORK  21,00"],
    ["wrong recap", "1  LOT WORK  1,000  20,00  20,00", "1  LOT WORK  1,000  21,00  21,00"],
    ["wrong tax", "Total T.V.A. 10,00 %  5,00", "Total T.V.A. 10,00 %  6,00"],
    ["wrong TTC", "Total T.T.C.  55,00", "Total T.T.C.  56,00"],
    ["numbering gap", "1.2  Electricity", "1.3  Electricity"],
    ["unparsed charge", "Sous-total LOT WORK", "Delivery  10,00\nCredit  -10,00\nSous-total LOT WORK"],
    ["unparsed integer charge", "Sous-total LOT WORK", "Delivery  10\nCredit  -10\nSous-total LOT WORK"],
    ["charge before recap", "N°  Récapitulatif", "Delivery  10,00\nCredit  -10,00\nN°  Récapitulatif"],
    ["integer charge before recap", "N°  Récapitulatif", "Delivery  10\nCredit  -10\nN°  Récapitulatif"],
  ])("refuses %s rather than returning partial rows", (_name, from, to) => {
    expect(recoverNumberedTable(pages.map(p => p.replace(from, to)))).toBeNull();
  });
  it("refuses missing page text", () => expect(recoverNumberedTable([...pages, null])).toBeNull());
  it("integrates recovery after partial AI output without counting recap as missing work", async () => {
    const { parseDocument } = await import("../../gmail/document-parser");
    const pdf = Buffer.from("native numbered fixture");
    const result = await parseDocument(pdf, "numbered.pdf", {
      pdfToImagesWithCoverage: async () => ({ images: pages.map(() => Buffer.from("image")), pdfPageCount: pages.length }),
      getPageTexts: async () => pages,
      getActiveModel: async () => ({ provider: "openai", modelId: "fixture" }),
      parseWithOpenAI: async () => ({ documentType: "quotation", amountHt: 50, amountTtc: 55,
        lineItems: [{ description: "Incomplete model row", total: 20 }] }),
      hasGeminiKey: () => false,
      getDenseCompletenessFallbackModelId: async () => null,
    });
    expect(result.lineItems).toHaveLength(3);
    expect(result.nativeTableRecovery?.parser).toBe("numbered-table-v1");
    expect(result.pricedItemVerification?.issues).toEqual([]);
    expect(result.extractionCoverage?.pageEvidence?.[2].candidateRows).toBe(0);
  });
});
