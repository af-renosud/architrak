import { describe, expect, it, vi } from "vitest";
import { recoverSourceVat } from "../quotation-vat-recovery";
import type { ArchitectCorrectionSnapshot } from "../../../shared/architect-quotation";
vi.mock("../quotation-poste-table", () => ({
  recoverPosteTable: () => ({
    rows: [{ description: "PS.27 HEAT PUMP", total: 100 }, { description: "AE.01 TREE", total: 200 }],
    evidence: [{ priceText: "TOTAL 1,00 100,00 100,00 120,00 20,00", pages: [1] }, { priceText: "TOTAL 1,00 200,00 200,00 220,00 10,00", pages: [2] }],
    amountHt: 300, amountTtc: 340,
  }),
}));
const snapshot = () => ({
  version: "v1", baseline: { ttc: "340.00" }, draft: {
    discountHt: "0.00", lines: [
      { clientKey: "heat", kind: "priced", included: true, descriptionFr: "Ps.27 My corrected description", descriptionEn: "My translation", totalHt: "100.00", vatRate: "" },
      { clientKey: "tree", kind: "priced", included: true, descriptionFr: "Ae.01 Tree", totalHt: "200.00", vatRate: "" },
    ],
  },
} as ArchitectCorrectionSnapshot);
describe("source VAT recovery", () => {
  it("recovers explicit mixed rates without changing saved descriptions", () => {
    const input = snapshot(), before = JSON.stringify(input);
    expect(recoverSourceVat(["source"], input).rates.map(r => r.vatRate)).toEqual(["20.00", "10.00"]);
    expect(JSON.stringify(input)).toBe(before);
  });
  it("refuses an amount-only match and a baseline discrepancy", () => {
    const input = snapshot();
    input.draft.lines[0].descriptionFr = "Different item";
    expect(() => recoverSourceVat(["source"], input)).toThrow("uniquely matched");
    const mismatch = snapshot(); mismatch.baseline!.ttc = "341.00";
    expect(() => recoverSourceVat(["source"], mismatch)).toThrow("does not reconcile");
  });
  it("does not overwrite an explicit operator VAT decision", () => {
    const input = snapshot(); input.draft.lines[0].vatRate = "5.5";
    expect(() => recoverSourceVat(["source"], input)).toThrow("existing VAT rate");
  });
});
