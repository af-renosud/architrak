import { describe, expect, it } from "vitest";
import { computeLine, computeWorksheet, percentOfCents, productCents, worksheetLinePatchSchema, type WorksheetLineData } from "../quotation-worksheet";

const base: WorksheetLineData = {
  id: 1, sourceLineItemId: 10, position: 10, section: "lot", lotLabel: "Lot", description: "x", unit: "u",
  originalQuantity: "3", originalUnitPrice: "33.33", originalTotal: "100", vatRate: "10",
  clientQuantity: "3", clientUnitPrice: "33.33", note: null, tag: null,
};

describe("client worksheet arithmetic", () => {
  it("rounds half away from zero in integer cents", () => {
    expect(productCents("1.5", "0.03")).toBe(5); // 4.5 cents → 5
    expect(productCents("2.345", "10.01")).toBe(2347); // 23.47345
    expect(percentOfCents(41246590, "10")).toBe(4124659);
    expect(percentOfCents(45371249, "30")).toBe(13611375); // VENIER: 30 % deposit of 453,712.49
  });

  it("keeps the extracted total until the client changes quantity or price", () => {
    expect(computeLine(base, "1.1")).toMatchObject({ status: "Unchanged", originalCents: 10000, revisedCents: 10000, differenceCents: 0 });
    expect(computeLine({ ...base, clientQuantity: "3.000" }, "1.1").status).toBe("Unchanged");
    expect(computeLine({ ...base, clientUnitPrice: "30" }, "1.1")).toMatchObject({ status: "Modified", revisedCents: 9000, differenceCents: -1000 });
    expect(computeLine({ ...base, clientQuantity: "0" }, "1.1")).toMatchObject({ status: "Removed", revisedCents: 0, differenceCents: -10000 });
  });

  it("never turns an unpriced line into €0", () => {
    const unpriced = { ...base, originalUnitPrice: null, originalTotal: null, clientUnitPrice: null };
    expect(computeLine(unpriced, "1.1")).toMatchObject({ status: "Not priced", originalCents: null, revisedCents: null, differenceCents: null });
    expect(computeLine({ ...unpriced, clientUnitPrice: "50" }, "1.1")).toMatchObject({ status: "Modified", revisedCents: 15000 });
    const added = { ...base, sourceLineItemId: null, originalQuantity: null, originalUnitPrice: null, originalTotal: null, clientUnitPrice: null };
    expect(computeLine(added, "M.1").status).toBe("Not priced");
    expect(computeLine({ ...added, clientUnitPrice: "12" }, "M.1")).toMatchObject({ status: "Added", revisedCents: 3600, differenceCents: 3600 });
  });

  it("uses each line's VAT rate, flags unknown rates and leaves deposit empty without a percentage", () => {
    const c = computeWorksheet([
      base,
      { ...base, id: 2, vatRate: "20", originalTotal: "50", originalQuantity: "1", originalUnitPrice: "50", clientQuantity: "1", clientUnitPrice: "50" },
      { ...base, id: 3, vatRate: null },
    ], null);
    expect(c.vat).toEqual([{ rate: "20", originalVatCents: 1000, revisedVatCents: 1000 }, { rate: "10", originalVatCents: 1000, revisedVatCents: 1000 }]);
    expect(c.unknownVatLineCount).toBe(1);
    expect(c.revised).toEqual({ htCents: 25000, vatCents: 2000, ttcCents: 27000, depositCents: null });
  });

  it("rejects malformed edits", () => {
    expect(worksheetLinePatchSchema.safeParse({ expectedRevision: 1, clientUnitPrice: "12.345" }).success).toBe(false);
    expect(worksheetLinePatchSchema.safeParse({ expectedRevision: 1, clientQuantity: "-1" }).success).toBe(false);
    expect(worksheetLinePatchSchema.safeParse({ expectedRevision: 1, originalTotal: "1" }).success).toBe(false);
    expect(worksheetLinePatchSchema.safeParse({ expectedRevision: 1, clientQuantity: "2.5", clientUnitPrice: "10" }).success).toBe(true);
  });
});
