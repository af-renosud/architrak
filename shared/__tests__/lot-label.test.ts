import { describe, it, expect } from "vitest";
import { formatLotDescription } from "../lot-label";

describe("formatLotDescription", () => {
  it("returns empty string for null/undefined", () => {
    expect(formatLotDescription(null)).toBe("");
    expect(formatLotDescription(undefined)).toBe("");
  });

  it("returns French only when English is missing", () => {
    expect(formatLotDescription({ descriptionFr: "Gros Oeuvre", descriptionUk: null })).toBe("Gros Oeuvre");
    expect(formatLotDescription({ descriptionFr: "Gros Oeuvre" })).toBe("Gros Oeuvre");
  });

  it("returns English only when French is missing", () => {
    expect(formatLotDescription({ descriptionFr: null, descriptionUk: "Structural Works" })).toBe("Structural Works");
  });

  it("formats both as 'FR (EN)' when both differ", () => {
    expect(
      formatLotDescription({ descriptionFr: "Gros Oeuvre", descriptionUk: "Structural Works" })
    ).toBe("Gros Oeuvre (Structural Works)");
  });

  it("returns single value when FR and EN are identical (no parens)", () => {
    expect(formatLotDescription({ descriptionFr: "Plomberie", descriptionUk: "Plomberie" })).toBe("Plomberie");
  });

  it("ignores whitespace-only English description", () => {
    expect(formatLotDescription({ descriptionFr: "Gros Oeuvre", descriptionUk: "   " })).toBe("Gros Oeuvre");
  });
});
