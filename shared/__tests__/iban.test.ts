import { describe, it, expect } from "vitest";
import {
  validateIban,
  validateBic,
  normaliseIban,
  normaliseBic,
  ibansMatch,
  safeExtractIban,
  safeExtractBic,
} from "../iban";

describe("validateIban (Task #225)", () => {
  it("accepts a known-valid French IBAN", () => {
    const r = validateIban("FR76 3000 6000 0112 3456 7890 189");
    expect(r.valid).toBe(true);
    expect(r.normalised).toBe("FR7630006000011234567890189");
  });
  it("rejects empty / null / whitespace", () => {
    expect(validateIban("").reason).toBe("empty");
    expect(validateIban(null).reason).toBe("empty");
    expect(validateIban("   ").reason).toBe("empty");
  });
  it("rejects too short / too long", () => {
    expect(validateIban("FR76").reason).toBe("length");
    expect(validateIban("FR76" + "0".repeat(40)).reason).toBe("length");
  });
  it("rejects bad shape", () => {
    expect(validateIban("12FRABCDEFGHIJKLMN").reason).toBe("format");
  });
  it("rejects bad checksum", () => {
    // Flip a digit on the valid sample → checksum fails.
    expect(validateIban("FR7630006000011234567890188").reason).toBe("checksum");
  });
});

describe("validateBic", () => {
  it("accepts 8 and 11 char BICs", () => {
    expect(validateBic("BNPAFRPP").valid).toBe(true);
    expect(validateBic("BNPAFRPPXXX").valid).toBe(true);
  });
  it("rejects bad length", () => {
    expect(validateBic("BNPAFR").reason).toBe("length");
  });
  it("rejects bad format", () => {
    expect(validateBic("1234FRPP").reason).toBe("format");
  });
});

describe("ibansMatch / normalisation", () => {
  it("matches whitespace + case variants", () => {
    expect(ibansMatch("fr76 3000 6000 0112 3456 7890 189", "FR7630006000011234567890189")).toBe(true);
  });
  it("does not match different IBANs", () => {
    expect(ibansMatch("FR7630006000011234567890189", "DE89370400440532013000")).toBe(false);
  });
  it("treats null/empty as no-match (never matches anything)", () => {
    expect(ibansMatch(null, "FR7630006000011234567890189")).toBe(false);
    expect(ibansMatch("", "")).toBe(false);
  });
  it("normaliseIban / normaliseBic strip whitespace and upper-case", () => {
    expect(normaliseIban("  fr 76 ")).toBe("FR76");
    expect(normaliseBic(" bnpafrpp ")).toBe("BNPAFRPP");
  });
});

describe("safeExtractIban / safeExtractBic", () => {
  it("returns null for invalid input so the column stores NULL", () => {
    expect(safeExtractIban("not an iban")).toBeNull();
    expect(safeExtractIban("")).toBeNull();
    expect(safeExtractIban(null)).toBeNull();
    expect(safeExtractBic("???")).toBeNull();
  });
  it("returns normalised value for valid input", () => {
    expect(safeExtractIban("fr76 3000 6000 0112 3456 7890 189")).toBe("FR7630006000011234567890189");
    expect(safeExtractBic("bnpafrpp")).toBe("BNPAFRPP");
  });
});
