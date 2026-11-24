import { describe, expect, it } from "vitest";
import { sourceRowsForCarriedWording } from "../quotation-carried-wording";
import type { Devis, DevisLineItem } from "@shared/schema";

const quotation = { pdfStorageKey: "original", aiExtractedData: { pricedItemVerification: { sourceDigest: "digest" } } } as Devis;
const before = { id: 1, devisId: 2, lineNumber: 3, description: "Original specification", quantity: "1.000",
  unitPriceHt: "100.00", totalHt: "100.00", unit: "u" } as DevisLineItem;
const after = { ...before, description: "Previously authored explanation of this specification" };
const audit = { kind: "carry_forward", targetSourceKey: "original", targetSourceDigest: "digest",
  wordingTransfers: [{ before, afterDescription: after.description }] };

describe("source-bound automatic wording retention", () => {
  it("reconciles retained wording to the existing source receipt, without changing working text", () => {
    expect(sourceRowsForCarriedWording(quotation, [after], [audit])).toEqual([before]);
    expect(after.description).not.toBe(before.description);
  });
  it("does not excuse later wording, amount, identity or PDF changes", () => {
    for (const change of [{ description: "New unreviewed text" }, { totalHt: "200.00" }, { lineNumber: 4 }, { devisId: 9 }]) {
      const line = { ...after, ...change };
      expect(sourceRowsForCarriedWording(quotation, [line], [audit])).toEqual([line]);
    }
    expect(sourceRowsForCarriedWording({ ...quotation, pdfStorageKey: "replacement" }, [after], [audit])).toEqual([after]);
    expect(sourceRowsForCarriedWording(quotation, [after], [{ ...audit, targetSourceDigest: "other" }])).toEqual([after]);
  });
});
