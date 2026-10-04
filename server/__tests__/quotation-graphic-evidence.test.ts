import { describe, it, expect } from "vitest";
import { graphicDimensions, graphicEvidenceIssues } from "../../shared/quotation-graphic-evidence";
describe("independent graphic evidence", () => {
  const printed = "018 - MEXT 205\nDim.LxH: 600mm X 700 mm";
  it("reads the final product dimensions independently", () => {
    expect(graphicDimensions(printed)).toEqual([600, 700]);
  });
  it("rejects the observed generative hallucination despite correct product and price", () => {
    expect(graphicEvidenceIssues("MEXT 205", printed,
      "MEXT 205 Dim. L x H : 800 mm x 1.760 mm")).toContain("Graphic dimensions are missing or conflict with independent OCR");
  });
  it("rejects unreadable evidence and equal-price reference swaps", () => {
    expect(graphicEvidenceIssues("MEXT 104", printed, printed).length).toBeGreaterThan(0);
    expect(graphicEvidenceIssues("MEXT 205", "", printed).length).toBeGreaterThan(0);
  });
  it("accepts a corroborated reference and dimensions without literal OCR spacing equality", () => {
    expect(graphicEvidenceIssues("MEXT 205", printed, "MEXT 205 Dim. L x H : 600 mm X 700 mm")).toEqual([]);
  });
});