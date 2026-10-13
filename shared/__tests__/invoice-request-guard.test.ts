import { describe, expect, it } from "vitest";
import { invoiceRequestConflict } from "../invoice-request-guard";

const evidence = {
  documentType: "invoice", amountHt: 63340, amountTtc: 69674, netAPayer: 20902.2, tvaRate: 10,
  openingDepositEvidenceText: "FACTURE D'ACOMPTE DE 30 % TTC",
  openingDepositSourceTotals: { amountHt: 63340, amountTtc: 69674, tvaAmount: 6334 },
};
const row = (amountHt: number | string, amountTtc: number | string) =>
  ({ amountHt, amountTtc, aiExtractedData: evidence });

describe("requested deposit amount safety", () => {
  it("refuses internally consistent contract totals despite a generic review acknowledgement", () => {
    expect(invoiceRequestConflict({ ...row("63340.00", "69674.00"), ...{ manualIntakeReviewRequired: false } }))
      .toContain("20902.20 EUR TTC (19002.00 EUR HT");
  });
  it("accepts the requested pair and preserves source totals", () => {
    expect(invoiceRequestConflict(row(19002, 20902.2))).toBeNull();
    expect(evidence.amountTtc).toBe(69674);
  });
  it("refuses either incorrect side", () => {
    expect(invoiceRequestConflict(row(63340, 20902.2))).toBeTruthy();
    expect(invoiceRequestConflict(row(19002, 69674))).toBeTruthy();
  });
  it("refuses non-finite values", () => {
    expect(invoiceRequestConflict(row("NaN", "NaN"))).toBeTruthy();
  });
  it("re-evaluates changed evidence", () => {
    expect(invoiceRequestConflict({ ...row(19002, 20902.2), aiExtractedData: {
      ...evidence, netAPayer: 27869.6, openingDepositEvidenceText: "FACTURE D'ACOMPTE DE 40 % TTC",
    } })).toBeTruthy();
  });
  it("requires review for missing or mixed tax evidence", () => {
    expect(invoiceRequestConflict({ ...row(19002, 20902.2), aiExtractedData: { ...evidence, tvaRate: undefined } }))
      .toContain("unresolved");
    expect(invoiceRequestConflict({ ...row(19002, 20902.2), aiExtractedData: { ...evidence, declaredTvaRates: [10, 20] } }))
      .toContain("unresolved");
  });
  it("distinguishes already-paid deductions", () => {
    expect(invoiceRequestConflict({ ...row(63340, 69674), aiExtractedData: { ...evidence, acomptePaidAmountTtc: 20902.2 } }))
      .toBeNull();
  });
  it("leaves ordinary invoices to normal validation", () => {
    expect(invoiceRequestConflict({ ...row(100, 120), aiExtractedData: { documentType: "invoice", amountHt: 100, amountTtc: 120 } }))
      .toBeNull();
  });
  it("allows printed totals that are themselves the explicit deposit request", () => {
    expect(invoiceRequestConflict({ ...row(19002, 20902.2), aiExtractedData: {
      ...evidence, openingDepositSourceTotals: undefined, amountHt: 19002, amountTtc: 20902.2,
    } })).toBeNull();
  });
});
