import { describe, expect, it } from "vitest";
import { extractedSourceTotal } from "../quotation-source-total-suggestion";

describe("original document total suggestion", () => {
  it("uses only an explicit extracted TTC, not working totals", () => {
    expect(extractedSourceTotal({ amountTtc: 75059, workingTotals: { ttc: "999" } })).toEqual({ ttc: "75059.00" });
    expect(extractedSourceTotal({ amountTtc: "120.50" })).toEqual({ ttc: "120.50" });
    expect(extractedSourceTotal({ workingTotals: { ttc: "120" }, lines: [{ totalHt: 100 }] })).toBeNull();
  });
  it.each([null, undefined, "", "12,50", "120 EUR", -1, Infinity, true, {}, 12.345])("does not invent or round an unusable total: %s", amountTtc => {
    expect(extractedSourceTotal({ amountTtc })).toBeNull();
  });
});
