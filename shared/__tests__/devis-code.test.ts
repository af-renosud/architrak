import { describe, it, expect } from "vitest";
import {
  composeDevisCode,
  tryParseDevisCode,
  validateDevisCodeParts,
  DEVIS_CODE_MAX_LOT_REF,
  DEVIS_CODE_MAX_DESCRIPTION,
  DEVIS_CODE_MAX_NUMBER,
  type DevisCodeParts,
} from "@shared/devis-code";

describe("composeDevisCode / tryParseDevisCode round-trip", () => {
  it("composes a structured code in `LOT.N.description` form", () => {
    const code = composeDevisCode({
      lotRef: "elec",
      lotSequence: 3,
      description: "Cabling and switches",
    });
    expect(code).toBe("ELEC.3.Cabling and switches");
  });

  it("parses a freshly composed code back to the original parts", () => {
    const parts: DevisCodeParts = {
      lotRef: "GO",
      lotSequence: 12,
      description: "Gros œuvre — fondations",
    };
    const round = tryParseDevisCode(composeDevisCode(parts));
    expect(round).toEqual({
      lotRef: "GO",
      lotSequence: 12,
      description: "Gros œuvre — fondations",
    });
  });

  it("preserves internal dots in the description (split is on the first two dots only)", () => {
    const parsed = tryParseDevisCode("ELEC.7.Phase 1.2 — install");
    expect(parsed).toEqual({
      lotRef: "ELEC",
      lotSequence: 7,
      description: "Phase 1.2 — install",
    });
  });

  it("trims whitespace around lotRef and description and uppercases the lotRef", () => {
    expect(
      composeDevisCode({
        lotRef: "  plumb  ",
        lotSequence: 1,
        description: "  Bathroom rough-in  ",
      }),
    ).toBe("PLUMB.1.Bathroom rough-in");
  });

  describe("returns null for legacy / non-structured codes", () => {
    const cases: Array<[string, string | null | undefined]> = [
      ["empty string", ""],
      ["null", null],
      ["undefined", undefined],
      ["plain free-text label", "DEV-2026-001"],
      ["only one dot", "ELEC.7"],
      ["leading dot (empty lotRef)", ".7.foo"],
      ["empty number segment", "ELEC..foo"],
      ["non-numeric number segment", "ELEC.abc.foo"],
      ["zero number segment", "ELEC.0.foo"],
      ["negative number segment", "ELEC.-1.foo"],
      ["empty description (whitespace only)", "ELEC.7.   "],
    ];
    for (const [name, input] of cases) {
      it(name, () => {
        expect(tryParseDevisCode(input)).toBeNull();
      });
    }
  });
});

describe("validateDevisCodeParts", () => {
  const ok: DevisCodeParts = { lotRef: "ELEC", lotSequence: 1, description: "Work" };

  it("returns no errors for a well-formed code", () => {
    expect(validateDevisCodeParts(ok)).toEqual([]);
  });

  it("flags a missing lotRef", () => {
    const errs = validateDevisCodeParts({ ...ok, lotRef: "   " });
    expect(errs).toContainEqual({ field: "lotRef", message: "Lot reference is required" });
  });

  it("rejects a dot inside lotRef (would break the parser)", () => {
    const errs = validateDevisCodeParts({ ...ok, lotRef: "EL.EC" });
    expect(errs.some((e) => e.field === "lotRef" && /cannot contain a dot/i.test(e.message))).toBe(true);
  });

  it("enforces the lotRef length cap", () => {
    const errs = validateDevisCodeParts({ ...ok, lotRef: "X".repeat(DEVIS_CODE_MAX_LOT_REF + 1) });
    expect(errs.some((e) => e.field === "lotRef" && /16 characters or less/.test(e.message))).toBe(true);
  });

  it("accepts the lotRef at exactly the length cap", () => {
    expect(validateDevisCodeParts({ ...ok, lotRef: "X".repeat(DEVIS_CODE_MAX_LOT_REF) })).toEqual([]);
  });

  it("rejects a non-integer / out-of-range lotSequence", () => {
    expect(validateDevisCodeParts({ ...ok, lotSequence: 0 })).toContainEqual(
      expect.objectContaining({ field: "lotSequence" }),
    );
    expect(validateDevisCodeParts({ ...ok, lotSequence: 1.5 })).toContainEqual(
      expect.objectContaining({ field: "lotSequence" }),
    );
    expect(validateDevisCodeParts({ ...ok, lotSequence: DEVIS_CODE_MAX_NUMBER + 1 })).toContainEqual(
      expect.objectContaining({ field: "lotSequence" }),
    );
    expect(validateDevisCodeParts({ ...ok, lotSequence: undefined })).toContainEqual(
      expect.objectContaining({ field: "lotSequence" }),
    );
  });

  it("flags a missing description", () => {
    expect(validateDevisCodeParts({ ...ok, description: "  " })).toContainEqual(
      expect.objectContaining({ field: "description", message: "Description is required" }),
    );
  });

  it("enforces the description length cap", () => {
    const errs = validateDevisCodeParts({ ...ok, description: "x".repeat(DEVIS_CODE_MAX_DESCRIPTION + 1) });
    expect(errs.some((e) => e.field === "description" && /200 characters or less/.test(e.message))).toBe(true);
  });
});
