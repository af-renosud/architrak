import { describe, expect, it } from "vitest";
import { compareQuotationContent, type QuotationSourceSegment } from "../../shared/quotation-content-coverage";

const source: QuotationSourceSegment[] = [
  { id: "a", page: 5, section: "010", text: "MEXT 104", disposition: "item" },
  { id: "b", page: 6, section: "010", text: "Vitrage 15 mm, pose comprise.", disposition: "item" },
  { id: "c", page: 6, section: "011", text: "MEXT 105", disposition: "item" },
  { id: "d", page: 10, section: "018", text: "MEXT 205, hors peinture.", disposition: "item" },
];
const candidates = [
  { section: "010", text: "MEXT 104\nVitrage 15 mm, pose comprise." },
  { section: "011", text: "MEXT 105" },
  { section: "018", text: "MEXT 205, hors peinture." },
];
describe("independent quotation text coverage", () => {
  it("accepts whitespace changes and cross-page continuation", () => {
    expect(compareQuotationContent(source, candidates, "").complete).toBe(true);
  });
  it("rejects shifted identities regardless of identical prices", () => {
    const shifted = candidates.map(c => ({ ...c }));
    [shifted[0].text, shifted[1].text] = [shifted[1].text, shifted[0].text];
    expect(compareQuotationContent(source, shifted, "").issues.some(i => i.kind === "misplaced")).toBe(true);
  });
  it("rejects a missing terminal specification", () => {
    expect(compareQuotationContent(source, candidates.slice(0, 2), "").issues).toContainEqual({
      segmentId: "d", page: 10, section: "018", kind: "missing",
    });
  });
  it("does not accept a numerical substring", () => {
    const changed = candidates.map(c => ({ ...c, text: c.text.replace("15 mm", "115 mm") }));
    expect(compareQuotationContent(source, changed, "").complete).toBe(false);
  });
  it("does not certify unreadable regions", () => {
    expect(compareQuotationContent([...source, {
      id: "unknown", page: 7, section: "012", text: "", disposition: "uncertain",
    }], candidates, "").complete).toBe(false);
  });
  it("requires explicit classification for skipped boilerplate", () => {
    expect(compareQuotationContent([{
      id: "footer", page: 1, section: "document", text: "Footer", disposition: "boilerplate",
    }], [], "").complete).toBe(false);
  });
  it("rejects a repeated passage within its target item", () => {
    expect(compareQuotationContent(source, candidates.map(c => ({ ...c, text: `${c.text} ${c.text}` })), "")
      .issues.some(i => i.kind === "duplicate")).toBe(true);
  });
  it("fails closed on an empty inventory", () => {
    expect(compareQuotationContent([], [], "").complete).toBe(false);
  });
  it("preserves legitimate repeated source text with the same multiplicity", () => {
    const repeated = [...source, { ...source[0], id: "repeat" }];
    expect(compareQuotationContent(repeated, candidates, "").complete).toBe(false);
    expect(compareQuotationContent(repeated, candidates.map((c, i) =>
      i === 0 ? { ...c, text: `${c.text} MEXT 104` } : c), "").complete).toBe(true);
  });
});