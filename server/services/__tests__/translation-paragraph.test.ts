import { describe, expect, it } from "vitest";
import { translationParagraph } from "../translation-paragraph";

describe("generated translation paragraphs", () => {
  it("joins headings, fragments and lists without losing conflicting conditions", () => {
    expect(translationParagraph("Supply and installation of aluminum joinery:\n- composed of\n008 - mext 102 fixed\nreference: 008 - mext 102\nif modification add a 50% surcharge\nif modification add a 100% surcharge\n- delivery and installation by our team"))
      .toBe("Supply and installation of aluminum joinery: composed of 008 - mext 102 fixed, reference: 008 - mext 102, if modification add a 50% surcharge, if modification add a 100% surcharge, and delivery and installation by our team.");
  });
  it("preserves measurements, signs, references and decimal values", () => {
    expect(translationParagraph("• surface = 1.1 m² / weight = 38.5 kg\r\n\r\n• 008 - fixed\r\n• -5 mm"))
      .toBe("surface = 1.1 m² / weight = 38.5 kg, 008 - fixed, and -5 mm.");
  });
  it("keeps existing paragraphs unchanged and avoids duplicate conjunctions", () => {
    expect(translationParagraph("Already a paragraph.")).toBe("Already a paragraph.");
    expect(translationParagraph("1. Frame;\n2. Glazing;\n3. and installation."))
      .toBe("Frame, Glazing, and installation.");
  });
});