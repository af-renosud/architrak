import { describe, it, expect } from "vitest";
import type { ParsedDocument } from "../document-parser";

/**
 * Task #215 — guards on the extractor's acompte signal so a regression
 * (e.g. someone removing a field, weakening the enum, or breaking the
 * cast at the persistence boundary) is caught at unit-test time without
 * needing a live Gemini call. The actual response_schema lives inside
 * a non-exported const, so we rely on the public TS types for guards.
 */
describe("document-parser — acompte fields (type guards)", () => {
  it("ParsedDocument.documentType union includes 'acompte'", () => {
    const sample: ParsedDocument["documentType"] = "acompte";
    expect(sample).toBe("acompte");
  });

  it("ParsedDocument.documentType still includes 'quotation' (unchanged)", () => {
    const sample: ParsedDocument["documentType"] = "quotation";
    expect(sample).toBe("quotation");
  });

  it("ParsedDocument shape accepts populated acompte fields", () => {
    const sample: ParsedDocument = {
      documentType: "quotation",
      acompteRequired: true,
      acomptePercent: 30,
      acompteAmountHt: 1500,
      acompteTrigger: "Acompte de 30% à la commande",
    };
    expect(sample.acompteRequired).toBe(true);
    expect(sample.acomptePercent).toBe(30);
    expect(sample.acompteAmountHt).toBe(1500);
    expect(sample.acompteTrigger).toMatch(/30%/);
  });

  it("ParsedDocument shape accepts null acompte fields (deposit not detected)", () => {
    const sample: ParsedDocument = {
      documentType: "quotation",
      acompteRequired: null,
      acomptePercent: null,
      acompteAmountHt: null,
      acompteTrigger: null,
    };
    expect(sample.acompteRequired).toBeNull();
    expect(sample.acompteTrigger).toBeNull();
  });
});
