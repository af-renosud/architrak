import { describe, expect, it } from "vitest";
import { quotationParagraph } from "../../../shared/quotation-paragraph";

describe("quotationParagraph", () => {
  it("joins PDF column wraps without changing words or figures", () => {
    expect(quotationParagraph("Échafaudage ( habitation et grange )\r\nréalisation, montage et démontage échafaudage\nsur la totalité des 2 bâtiment ."))
      .toBe("Échafaudage ( habitation et grange ) réalisation, montage et démontage échafaudage sur la totalité des 2 bâtiment .");
  });
  it("preserves bullet separators and technical punctuation", () => {
    expect(quotationParagraph("PAC 16kW\n• pose\n• tests 0,1 bar\n24 h")).toBe("PAC 16kW • pose • tests 0,1 bar 24 h");
  });
  it("is idempotent and supports absent English wording", () => {
    expect(quotationParagraph(null)).toBe("");
    const text = quotationParagraph("Pressure\n testing\t24 hours.");
    expect(quotationParagraph(text)).toBe(text);
  });
});
