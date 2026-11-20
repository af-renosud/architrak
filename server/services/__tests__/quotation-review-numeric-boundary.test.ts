import { describe, expect, it } from "vitest";
import { draftFrom, correctedFinancialBlocker } from "../architect-quotation-correction";

describe("unchanged review at the PostgreSQL JSON boundary", () => {
  it("uses the same exact-money draft for JSON numeric and pg numeric-string rows", () => {
    const state = {
      quotation: { ai_extracted_data: { tvaRate: 10 }, description_fr: "Roof" },
      translation: null, baseline: null, state: null,
      lines: [{ id: 1, line_number: 1, description: "Roof", quantity: 1, unit: "u", unit_price_ht: 300, total_ht: 300 }],
    };
    const draft = draftFrom(state);
    expect(draft.lines[0]).toMatchObject({ quantity: "1", unitPriceHt: "300", totalHt: "300", vatRate: "10" });
    expect(correctedFinancialBlocker(draft, { ttc: "330.00" }, { ht: "300.00", ttc: "330.00" })).toBeNull();
    expect(correctedFinancialBlocker(draft, { ttc: "331.00" })).toContain("don't match the original total");
  });
});
