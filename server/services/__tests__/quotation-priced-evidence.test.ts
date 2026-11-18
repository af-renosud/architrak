import { describe, expect, it } from "vitest";
import { collectPricedEvidence, pricedRowsDigest } from "../quotation-priced-evidence";
import { createHash } from "node:crypto";
import type { ParsedDocument } from "../../gmail/document-parser";

const pdf = Buffer.from("source receipt");
const parsed: ParsedDocument = { documentType: "quotation",
  lineItems: [{ description: "PS.27 Heat pump", quantity: 1, unitPrice: 7606, total: 7606, pageHint: 5 }] };
describe("priced source receipts", () => {
  it("never treats model descriptions, confidence or matching totals as proof", () => {
    expect(collectPricedEvidence({ ...parsed, amountHt: 7606 }, pdf).issues).toHaveLength(1);
  });
  it("accepts a fresh native source transcription and rejects changed bytes", () => {
    const backed: ParsedDocument = { ...parsed, nativeTableRecovery: {
      parser: "poste-table-v1", sourceDigest: createHash("sha256").update(pdf).digest("hex"),
      initialLineItems: [], amountHt: 7606, amountTtc: 9127.2,
      evidence: [{ pages: [5, 6], priceText: "TOTAL DU POSTE     1,00     7606,00     7606,00     9127,20     20,00", sourceText: "PS.27 Heat pump" }],
    } };
    expect(collectPricedEvidence(backed, pdf).issues).toEqual([]);
    expect(collectPricedEvidence(backed, Buffer.from("different source")).issues).toHaveLength(1);
  });
  it("allows persistence sentence casing but binds amounts and specifications", () => {
    const original = pricedRowsDigest(parsed.lineItems!);
    expect(pricedRowsDigest([{ description: "Ps.27 heat pump", total: 7606 }])).toBe(original);
    expect(pricedRowsDigest([{ description: "Ps.27 heat pump", total: 5200 }])).not.toBe(original);
    expect(pricedRowsDigest([{ description: "Ps.27 different pump", total: 7606 }])).not.toBe(original);
  });
});
