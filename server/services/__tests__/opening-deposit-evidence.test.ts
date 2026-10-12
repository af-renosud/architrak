import { describe, expect, it } from "vitest";
import { validateExtraction } from "../extraction-validator";
import { openingDepositEvidence } from "../opening-deposit-evidence";
import type { ParsedDocument } from "../../gmail/document-parser";

const invoice = {
  documentType: "invoice", amountHt: 63340, tvaAmount: 6334, amountTtc: 69674,
  netAPayer: 20902.20, rawText: "FACTURE D'ACOMPTE DE 30 % TTC CONFORMEMENT\nA VOTRE ENGAGEMENT DE COMMANDE SOIT :\n20 902,20 €",
} as ParsedDocument;
const mismatch = (value: ParsedDocument) => validateExtraction(value).warnings.some(w => w.field === "netAPayer");
describe("opening deposit request evidence", () => {
  it("recognises the printed 30% request without changing any monetary field", () => {
    const copy = { ...invoice };
    expect(mismatch(copy)).toBe(false);
    expect(copy.amountTtc).toBe(69674);
    expect(copy.netAPayer).toBe(20902.20);
    expect(copy.acomptePaidAmountTtc).toBeUndefined();
  });
  it("uses deterministic text-layer evidence even if AI omitted the raw text", () => {
    expect(mismatch({ ...invoice, documentType: "acompte", rawText: undefined,
      openingDepositEvidenceText: "FACTURE D’ACOMPTE DE 30 % TTC" })).toBe(false);
  });
  it.each([
    { rawText: "" },
    { rawText: "FACTURE D'ACOMPTE", documentType: "acompte" },
    { rawText: "Conditions : acompte de 30 % TTC à la commande" },
    { rawText: "Déduction FACTURE D'ACOMPTE DE 30 % TTC" },
    { rawText: "FACTURE D'ACOMPTE DE 30 % TTC déjà payée" },
    { rawText: "FACTURE D'ACOMPTE DE 30 % HT" },
    { rawText: "FACTURE D'ACOMPTE DE 100 % TTC" },
    { netAPayer: 20900 },
    { retenueDeGarantie: 50 },
    { acomptePaidAmountTtc: 500 },
    { documentType: "quotation" },
    { documentType: "situation" },
  ])("keeps genuine or unproven discrepancies: %j", change => {
    expect(mismatch({ ...invoice, ...change } as ParsedDocument)).toBe(true);
  });
  it("preserves the ordinary paid-deposit subtraction check", () => {
    expect(mismatch({ ...invoice, rawText: "", acomptePaidAmountTtc: 20902.2, netAPayer: 48771.8 })).toBe(false);
  });
  it("does not suppress other extraction warnings", () => {
    const warnings = validateExtraction({ ...invoice, amountHt: 60000 }).warnings;
    expect(warnings.some(w => w.field === "netAPayer")).toBe(false);
    expect(warnings.length).toBeGreaterThan(0);
  });
  it("supports whitespace and decimal percentages without inventing a percentage", () => {
    expect(openingDepositEvidence("FACTURE D’ACOMPTE DE 12,5 % T.T.C.")).toMatchObject({ percentage: 12.5 });
    expect(openingDepositEvidence("FACTURE D’ACOMPTE DE 30 % HT")).toBeNull();
  });
});
