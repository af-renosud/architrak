import { describe, expect, it } from "vitest";
import { computeQuotationChecks, documentVatRate, mentionedVatRates, type CheckLineInput } from "../quotation-checks";

let id = 0;
const L = (p: Partial<CheckLineInput>): CheckLineInput => {
  id++;
  return { id, lineNumber: id, description: `Line ${id}`, quantity: "1", unit: "U", unitPriceHt: "100", totalHt: "100", vatRate: null, ...p };
};
const byCat = (pts: ReturnType<typeof computeQuotationChecks>, c: string) => pts.filter(p => p.category === c);

describe("automatic points to check", () => {
  it("flags the same quantity and unit repeated across different lots, not within one lot", () => {
    id = 0;
    const lines = [
      L({ description: "LOT DALLAGE ET CHAPES Chape fluide anhydrite", quantity: "37", unit: "M2", unitPriceHt: "65", totalHt: "2405" }),
      L({ description: "LOT PLATERIE Enduit chaux", quantity: "143", unit: "M2", unitPriceHt: "10", totalHt: "1430" }),
      L({ description: "Second enduit", quantity: "143", unit: "m²", unitPriceHt: "5", totalHt: "715" }),
      L({ description: "Lot cloison FOURNITURE ET POSE DE PARQUET", quantity: "37", unit: "m2", unitPriceHt: "165", totalHt: "6105" }),
      L({ description: "LOT ELEC Prises", quantity: "2", unit: "U", unitPriceHt: "50", totalHt: "100" }),
      L({ description: "LOT PLOMBERIE Robinets", quantity: "2", unit: "U", unitPriceHt: "50", totalHt: "100" }),
    ];
    const pts = byCat(computeQuotationChecks(lines, { documentVatRate: 10 }), "duplicate_scope");
    expect(pts).toHaveLength(1);
    expect(pts[0].lines.map(l => l.lineNumber)).toEqual([1, 4]);
    expect(pts[0].finding).toContain("DALLAGE ET CHAPES, Cloison");
  });

  it("groups near-identical descriptions (two water heaters) but ignores lot headings and unrelated lines", () => {
    id = 0;
    const lines = [
      L({ description: "Lot CVC Plomberie Fourniture et pose chauffe-eau électrique 300 L vertical mural, groupe de sécurité" }),
      L({ description: "Fourniture et pose radiateur sèche-serviettes 750 W" }),
      L({ description: "Fourniture et pose chauffe-eau électrique 300 L vertical mural, groupe de sécurité" }),
    ];
    const pts = byCat(computeQuotationChecks(lines, { documentVatRate: null }), "duplicate_equipment");
    expect(pts).toHaveLength(1);
    expect(pts[0].lines.map(l => l.lineNumber)).toEqual([1, 3]);
  });

  it("flags unpriced lines with a quantity and quantity × price ≠ total", () => {
    id = 0;
    const lines = [
      L({ quantity: "3", unit: "u", unitPriceHt: null, totalHt: "0" }),
      L({ quantity: "3", unitPriceHt: "33.33", totalHt: "99.99" }),
      L({ quantity: "4", unitPriceHt: "125", totalHt: "450" }),
      L({ quantity: null, unitPriceHt: null, totalHt: "0" }),
    ];
    const pts = computeQuotationChecks(lines, { documentVatRate: null });
    expect(byCat(pts, "unpriced_line").map(p => p.lines[0].lineNumber)).toEqual([1]);
    const arith = byCat(pts, "arithmetic");
    expect(arith.map(p => p.lines[0].lineNumber)).toEqual([3]);
    expect(arith[0].finding).toContain("500,00 €");
  });

  it("flags a VAT rate written in a description that differs from the applied rate", () => {
    expect(mentionedVatRates("Panneaux photovoltaïques — TVA 5,5 % sous attestation")).toEqual([5.5]);
    expect(mentionedVatRates("10% TVA réduite")).toEqual([10]);
    expect(mentionedVatRates("Remise 10 % sur fournitures")).toEqual([]);
    id = 0;
    const lines = [
      L({ description: "Isolation combles — TVA 5,5 %" }),
      L({ description: "Isolation murs — TVA 5,5 %", vatRate: "5.5" }),
      L({ description: "Peinture TVA 10%" }),
    ];
    const pts = byCat(computeQuotationChecks(lines, { documentVatRate: documentVatRate("1000", "1100") }), "vat_mention");
    expect(pts.map(p => p.lines[0].lineNumber)).toEqual([1]);
    expect(pts[0].finding).toBe("The description mentions VAT at 5,5 %, but 10 % is applied to the quotation total.");
  });

  it("keys are stable for the same lines and change when the figures change", () => {
    id = 0;
    const a = computeQuotationChecks([L({ quantity: "2", unitPriceHt: "10", totalHt: "25" })], { documentVatRate: null });
    id = 0;
    const b = computeQuotationChecks([L({ quantity: "2", unitPriceHt: "10", totalHt: "25" })], { documentVatRate: null });
    id = 0;
    const c = computeQuotationChecks([L({ quantity: "2", unitPriceHt: "10", totalHt: "26" })], { documentVatRate: null });
    expect(a[0].key).toBe(b[0].key);
    expect(c[0].key).not.toBe(a[0].key);
    expect(documentVatRate("412465.90", "453712.49")).toBe(10);
    expect(documentVatRate("100", "113")).toBeNull();
  });
});
