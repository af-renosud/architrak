import { describe, expect, it } from "vitest";
import { verifyQuotationManifest } from "../services/quotation-source-manifest";
import type { ParsedDocument } from "../gmail/document-parser";

const r = (page: number, y: number) => ({ page, x: 0.1, y, w: 0.8, h: 0.1 });
const manifest = {
  sections: [
    { id: "010", reference: "WIN-A", priceRegion: r(1, 0.8), specificationRegions: [r(2, 0.1)], quantity: 1, unitPrice: 100, total: 100 },
    { id: "011", reference: "WIN-B", priceRegion: r(2, 0.4), specificationRegions: [r(2, 0.6)], quantity: 1, unitPrice: 100, total: 100 },
  ],
  segments: [
    { id: "a", section: "010", page: 2, text: "WIN-A double vitrage", disposition: "item", region: r(2, 0.1) },
    { id: "b", section: "011", page: 2, text: "WIN-B hors peinture", disposition: "item", region: r(2, 0.6) },
  ],
  inventoriedPages: [1, 2],
};
const rows = [
  { page: 1, quantity: 1, unitPrice: 100, total: 100 },
  { page: 2, quantity: 1, unitPrice: 100, total: 100 },
];
const candidate: ParsedDocument = {
  documentType: "quotation",
  lineItems: manifest.segments.map(s => ({ description: s.text, quantity: 1, unitPrice: 100, total: 100 })),
};
describe("independent source manifest verification", () => {
  it("supports a specification starting on the following page", () => {
    expect(verifyQuotationManifest(manifest, rows, candidate, 2).verified).toBe(true);
  });
  it("rejects equal-price description swaps", () => {
    expect(verifyQuotationManifest(manifest, rows, { ...candidate, lineItems: [...candidate.lineItems!].reverse() }, 2).verified).toBe(false);
  });
  it("rejects a missing page even with all financial rows", () => {
    expect(verifyQuotationManifest({ ...manifest, inventoriedPages: [1] }, rows, candidate, 2).verified).toBe(false);
  });
  it("rejects a specification crossing the next introduction", () => {
    const changed = structuredClone(manifest);
    changed.sections[0].specificationRegions = [r(2, 0.5)];
    expect(verifyQuotationManifest(changed, rows, candidate, 2).verified).toBe(false);
  });
  it("rejects malformed or absent evidence", () => {
    expect(verifyQuotationManifest({}, rows, candidate, 2).verified).toBe(false);
  });
});