import { describe, expect, it } from "vitest";
import { alignCodedLotRows, codedLotDescriptionMatches, compactWords, recoverCodedLotTable } from "../quotation-coded-lot-table";
import { suggestCarryMatches } from "../quotation-carry-forward";
import type { CarryLine } from "@shared/quotation-carry-forward";

// Synthetic layout mirroring the supplier's Stimulsoft export: letter-spaced LOT
// headings, LOT subtotals, mixed 5.5% / 10% VAT and a summary page followed by terms.
const head = "Code       Description                                   Qté      Unité     P.U. HT     % Rem     Montant HT     TVA";
const page1 = [
  head,
  "           L OT IN STAL L ATION                          1,00                  1 500,00               1 500,00      0,00",
  "PAC01      P OMPE A CH AL EUR                            1,00      U           1 000,00               1 000,00      5,50",
  "           Air/eau 8 kW",
  "TUY02      Tuyauterie cuivre                             10,00     ml          50,00                  500,00        10,00",
  "           T OTAL L OT IN STAL L ATION                   1,00                  1 500,00               1 500,00      0,00",
  "1 sur 2",
].join("\n");
const page2 = [
  head,
  "           Devis gratuit",
  "Taux     Base HT       Montant TVA",
  "5,50     1 000,00      55,00",
  "10,00    500,00        50,00",
  "Montant HT Net     1 500,00 €",
  "Total TVA          105,00 €",
  "Total TTC          1 605,00 €",
].join("\n");
const terms = "Conditions générales de vente  12,00";

describe("coded lot table reader", () => {
  it("reads per-line VAT, LOT subtotals and the VAT summary to the cent", () => {
    const r = recoverCodedLotTable([page1, page2, terms])!;
    expect(r).not.toBeNull();
    expect(r.rows.map(row => [row.total, row.vatRate])).toEqual([[1000, "5.5"], [500, "10"]]);
    expect(r.rows[0].description).toBe("P OMPE A CH AL EUR\nAir/eau 8 kW");
    expect([r.amountHt, r.tvaAmount, r.amountTtc]).toEqual([1500, 105, 1605]);
    expect(r.vatSummary).toEqual([{ rate: "5.5", baseHt: 1000, vat: 55 }, { rate: "10", baseHt: 500, vat: 50 }]);
  });
  it("refuses when a VAT base or the TTC does not reconcile", () => {
    expect(recoverCodedLotTable([page1, page2.replace("1 000,00      55,00", "1 000,00      100,00")])).toBeNull();
    expect(recoverCodedLotTable([page1, page2.replace("1 605,00", "1 606,00")])).toBeNull();
    expect(recoverCodedLotTable([page1.replace("10,00     ml          50,00                  500,00", "10,00     ml          50,00                  510,00"), page2])).toBeNull();
  });
  it("pairs model wording despite letter-spacing and rejects foreign wording", () => {
    const r = recoverCodedLotTable([page1, page2])!;
    expect(codedLotDescriptionMatches(r.evidence[0], "Pompe à chaleur air/eau 8 kW")).toBe(true);
    expect(codedLotDescriptionMatches(r.evidence[0], "Chaudière gaz")).toBe(false);
    const model = [
      { description: "Pompe à chaleur air/eau 8 kW", quantity: 1, unitPrice: 1000, total: 1000 },
      { description: "Tuyauterie cuivre", quantity: 10, unitPrice: 50, total: 500 },
    ];
    expect(alignCodedLotRows(model, r)?.map(row => row.vatRate)).toEqual(["5.5", "10"]);
    expect(alignCodedLotRows([model[0], { ...model[1], total: 501 }], r)).toBeNull();
  });
});

const line = (id: number, description: string, totalHt: string, extra: Partial<CarryLine> = {}): CarryLine => ({
  id, lineNumber: id, description, quantity: "1", unit: "u", unitPriceHt: totalHt, totalHt,
  translation: null, context: null, imageCount: 0, suggestedTargetId: null, ...extra,
});
describe("carry-forward by printed wording", () => {
  it("matches identical items exactly and same-wording items with changed figures", () => {
    const result = suggestCarryMatches(
      [line(1, "Dépose toiture", "100.00"), line(2, "Pose  tuiles", "200.00")],
      [line(11, "Dépose toiture", "100.00"), line(12, "POSE TUILES.", "250.00"), line(13, "Nouvelle gouttière", "80.00")]);
    expect(result.map(r => [r.suggestedTargetId, r.matchKind, r.figuresChanged])).toEqual([[11, "exact", false], [12, "wording", true]]);
    expect(compactWords("Pose  tuiles")).toBe(compactWords("POSE TUILES."));
  });
  it("never matches repeated wording", () => {
    const result = suggestCarryMatches(
      [line(1, "Main d'oeuvre", "100.00"), line(2, "Main d'oeuvre", "150.00")],
      [line(11, "Main d'oeuvre", "120.00")]);
    expect(result.map(r => r.suggestedTargetId)).toEqual([null, null]);
    const repeatedTarget = suggestCarryMatches([line(1, "Nettoyage", "10.00")], [line(11, "Nettoyage", "20.00"), line(12, "Nettoyage", "30.00")]);
    expect(repeatedTarget[0].suggestedTargetId).toBeNull();
  });
});

import { printedVatIssues } from "../quotation-source-evidence";
describe("printed VAT check", () => {
  const r = recoverCodedLotTable([page1, page2])!;
  const parsed = { lineItems: r.rows, nativeTableRecovery: { parser: "coded-lot-table-v1", evidence: r.evidence,
    amountHt: r.amountHt, amountTtc: r.amountTtc, vatSummary: r.vatSummary }, pricedItemVerification: { issues: [] } } as any;
  const lines = [{ id: 7, lineNumber: 1 }, { id: 8, lineNumber: 2 }] as any;
  const draft = (a: string, b: string, discountHt = "0.00") => ({ discountHt, lines: [
    { id: 7, clientKey: "a", kind: "priced", included: true, descriptionFr: "x", totalHt: "1000.00", vatRate: a },
    { id: 8, clientKey: "b", kind: "priced", included: true, descriptionFr: "y", totalHt: "500.00", vatRate: b },
  ] }) as any;
  it("passes when every rate and the TTC match the PDF", () => {
    expect(printedVatIssues(parsed, lines, draft("5.5", "10"))).toEqual([]);
  });
  it("names the line whose VAT differs", () => {
    const issues = printedVatIssues(parsed, lines, draft("10", "10"));
    expect(issues.map(i => [i.code, i.target.rowId])).toEqual([["VAT_RATE_MISMATCH", 7]]);
    expect(issues[0].message).toContain("PDF prints 5.5%");
  });
  it("reports a TTC difference when rates match but figures do not", () => {
    expect(printedVatIssues(parsed, lines, draft("5.5", "10", "10.00")).map(i => i.code)).toEqual(["SOURCE_TTC_MISMATCH"]);
  });
});
