import { describe, expect, it } from "vitest";
import { sourceMatchKey, uniqueSourceMatches } from "../../../shared/quotation-source-match";

const item = { description: "Pose d’une pompe\nà chaleur", quantity: 1, unit: "u", unitPrice: 2500, total: 2500 };
describe("exact contractor-source identity", () => {
  it("ignores layout but retains qualifications and financial identity", () => {
    expect(sourceMatchKey(item)).toBe(sourceMatchKey({ ...item, description: "Pose d'une pompe à chaleur" }));
    expect(sourceMatchKey(item)).not.toBe(sourceMatchKey({ ...item, description: item.description + " hors raccordement" }));
    expect(sourceMatchKey(item)).not.toBe(sourceMatchKey({ ...item, quantity: 2 }));
    expect(sourceMatchKey(item)).not.toBe(sourceMatchKey({ ...item, unitPrice: 2600 }));
  });
  it("does not guess from unknown prices or repeated rows", () => {
    expect(sourceMatchKey({ ...item, total: undefined })).toBeNull();
    expect(sourceMatchKey({ ...item, total: "NaN" })).toBeNull();
    expect(uniqueSourceMatches([item], [item, { ...item }], r => r, r => r).size).toBe(0);
  });
  it("recognises reader-proven headings and unit typography, but not arbitrary omissions", () => {
    const old = { ...item, unit: "m²" };
    const next = { ...item, unit: "m2", description: `LOT CHAUFFAGE ${item.description}`, sectionPrefix: "LOT CHAUFFAGE" };
    expect(uniqueSourceMatches([old], [next], r => r, r => r).get(old)).toBe(next);
    expect(uniqueSourceMatches([old], [{ ...next, sectionPrefix: undefined }], r => r, r => r).size).toBe(0);
    expect(uniqueSourceMatches([old], [{ ...next, description: next.description + " sans raccordement" }], r => r, r => r).size).toBe(0);
  });
  it("matches source evidence independently of working edits or positions", () => {
    const old = { id: 3, wording: "Architect's fuller description", source: item };
    const added = { id: 5, source: { ...item, description: "New work" } };
    const unchanged = { id: 6, source: { ...item } };
    expect(uniqueSourceMatches([old], [added, unchanged], r => r.source, r => r.source).get(old)).toBe(unchanged);
  });
});
