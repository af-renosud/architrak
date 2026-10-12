import { describe, expect, it } from "vitest";
import { invoiceRequestAmounts } from "../invoice-request-amounts";
import { validateExtraction } from "../extraction-validator";
import { calculateInvoicePair, declaredTvaRates, invoiceDocumentTvaRate, printedOpeningDepositRequest } from "../../../shared/invoice-deposit";
import type { ParsedDocument } from "../../gmail/document-parser";

const source = (): ParsedDocument => ({
  documentType: "invoice", amountHt: 63340, amountTtc: 69674, tvaAmount: 6334,
  tvaRate: 10, netAPayer: 20902.2,
  rawText: "TVA 10,0 %\nFACTURE D'ACOMPTE DE 30 % TTC CONFORMEMENT\nA VOTRE ENGAGEMENT DE COMMANDE SOIT :\n20 902,20 €",
  lineItems: [{ description: "Full contract works", quantity: 1, unitPrice: 63340, total: 63340 }],
});

describe("invoice requested-deposit amounts", () => {
  it("records the request, retaining original totals and never manufacturing paid evidence", () => {
    const parsed = source();
    expect(invoiceRequestAmounts(parsed)).toEqual({ amountHt: 19002, amountTtc: 20902.2 });
    expect(parsed.amountHt).toBe(63340);
    expect(parsed.amountTtc).toBe(69674);
    expect(parsed.openingDepositSourceTotals?.amountTtc).toBe(69674);
    expect(parsed.acomptePaidAmountTtc).toBeUndefined();
    expect(invoiceRequestAmounts(parsed)).toEqual({ amountHt: 19002, amountTtc: 20902.2 });
  });
  it("revalidates deposit amounts without comparing full work lines against the deposit", () => {
    const parsed = source();
    const amounts = invoiceRequestAmounts(parsed);
    const result = validateExtraction({ ...parsed, ...amounts, tvaAmount: 1900.2 });
    expect(result.warnings).toEqual([]);
  });
  it.each([
    { tvaRate: undefined, rawText: "FACTURE D'ACOMPTE DE 30 % TTC" },
    { declaredTvaRates: [10, 20] },
    { tvaRate: 20 },
    { acomptePaidAmountTtc: 100 },
    { retenueDeGarantie: 100 },
    { autoLiquidation: true },
    { netAPayer: 20000 },
    { documentType: "quotation" as const },
  ])("does not rewrite ambiguous or unrelated source amounts: %j", change => {
    const parsed = { ...source(), ...change };
    expect(invoiceRequestAmounts(parsed)).toEqual({ amountHt: 63340, amountTtc: 69674 });
  });
  it("recovers the printed request even when the template net à payer repeats full TTC", () => {
    expect(printedOpeningDepositRequest(source().rawText!, 69674)).toBe(20902.2);
    expect(printedOpeningDepositRequest(source().rawText!.replace("20 902,20", "20 000,00"), 69674)).toBeNull();
  });
  it("collects multiple explicit tax rates and refuses to infer a blended rate", () => {
    expect(declaredTvaRates("TVA 10 % TVA 20 % TVA 10 %")).toEqual([10, 20]);
    expect(invoiceDocumentTvaRate({ amountHt: 100, amountTtc: 120 })).toBeNull();
  });
  it("calculates either direction and rejects invalid input", () => {
    expect(calculateInvoicePair(20902.2, "ttc", 10)).toEqual({ amountHt: 19002, amountTtc: 20902.2, tvaAmount: 1900.2 });
    expect(calculateInvoicePair(19002, "ht", 10)?.amountTtc).toBe(20902.2);
    expect(calculateInvoicePair(NaN, "ttc", 10)).toBeNull();
    expect(calculateInvoicePair(-1, "ttc", 10)).toBeNull();
  });
});
