import { describe, it, expect } from "vitest";
import { hasSignedOrClosedEvidence, missingSourceTotalChanges } from "../quotation-source-guards";
describe("source authority", () => {
  it("permits completing blank intake totals, not changing recorded totals", () => {
    const missing = { pdfStorageKey: "original", amountHt: "0", amountTtc: "0", aiExtractedData: {} };
    expect(missingSourceTotalChanges(missing, { amountHt: 100, amountTtc: 120 })).toEqual(["amountHt", "amountTtc"]);
    expect(() => missingSourceTotalChanges({ ...missing, amountHt: "100", aiExtractedData: { amountHt: 100 } }, { amountHt: 99 })).toThrow("cannot be amended");
    expect(() => missingSourceTotalChanges({ ...missing, aiExtractedData: { amountHt: 0 } }, { amountHt: 99 })).toThrow();
  });
  it("permits a missing TTC placeholder copied from HT, but not an explicit source TTC", () => {
    const fallback = { pdfStorageKey: "original", amountHt: "100", amountTtc: "100", aiExtractedData: { amountHt: 100 } };
    expect(missingSourceTotalChanges(fallback, { amountTtc: 120 })).toEqual(["amountTtc"]);
    expect(() => missingSourceTotalChanges({ ...fallback, aiExtractedData: { amountHt: 100, amountTtc: 100 } }, { amountTtc: 120 })).toThrow();
  });
  it("recognises camel and SQL evidence and refuses signed missing-total transcription", () => {
    expect(hasSignedOrClosedEvidence({ manualSignoffAt: "date", signOffStage: "received" })).toBe(true);
    expect(hasSignedOrClosedEvidence({ signed_pdf_storage_key: "signed", sign_off_stage: "received" })).toBe(true);
    expect(() => missingSourceTotalChanges({ pdfStorageKey: "original", amountHt: 0, manualSignoffAt: "date" }, { amountHt: 100 })).toThrow();
  });
});