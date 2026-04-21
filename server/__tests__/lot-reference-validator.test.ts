import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../storage", () => ({
  storage: {
    getLotCatalogByCode: vi.fn(),
  },
}));

import { storage } from "../storage";
import {
  checkLotReferencesAgainstCatalog,
  extractCandidateCodes,
} from "../services/lot-reference-validator";

const getLotCatalogByCode = storage.getLotCatalogByCode as unknown as ReturnType<typeof vi.fn>;

describe("extractCandidateCodes", () => {
  it("strips the word 'Lot' and returns alphanumeric tokens uppercased", () => {
    expect(extractCandidateCodes("Lot 7 - Electricite")).toEqual(["7", "ELECTRICITE"]);
  });

  it("handles already-bare codes", () => {
    expect(extractCandidateCodes("GO")).toEqual(["GO"]);
  });

  it("dedupes repeats and ignores too-long tokens", () => {
    expect(extractCandidateCodes("Lot GO GO GO " + "X".repeat(20))).toEqual(["GO"]);
  });

  it("returns empty for empty input", () => {
    expect(extractCandidateCodes("")).toEqual([]);
  });
});

describe("checkLotReferencesAgainstCatalog", () => {
  beforeEach(() => {
    getLotCatalogByCode.mockReset();
  });

  it("returns no warnings when there are no lot references", async () => {
    const warnings = await checkLotReferencesAgainstCatalog({ documentType: "quotation" });
    expect(warnings).toEqual([]);
    expect(getLotCatalogByCode).not.toHaveBeenCalled();
  });

  it("returns no warning when at least one candidate code matches the catalog", async () => {
    getLotCatalogByCode.mockImplementation(async (code: string) =>
      code === "ELECTRICITE" ? { id: 1, code: "ELECTRICITE", descriptionFr: "Électricité" } : undefined,
    );
    const warnings = await checkLotReferencesAgainstCatalog({
      documentType: "quotation",
      lotReferences: ["Lot 7 - Electricite"],
    });
    expect(warnings).toEqual([]);
  });

  it("emits a needs-new-lot warning when no candidate matches", async () => {
    getLotCatalogByCode.mockResolvedValue(undefined);
    const warnings = await checkLotReferencesAgainstCatalog({
      documentType: "quotation",
      lotReferences: ["Lot 99 - Mystère"],
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0].field).toBe("lotReferences");
    expect(warnings[0].severity).toBe("warning");
    expect(warnings[0].message).toMatch(/needs new lot/i);
    expect(warnings[0].actual).toBe("Lot 99 - Mystère");
  });

  it("dedupes warnings for repeated unknown references", async () => {
    getLotCatalogByCode.mockResolvedValue(undefined);
    const warnings = await checkLotReferencesAgainstCatalog({
      documentType: "quotation",
      lotReferences: ["Lot 99", "Lot 99"],
    });
    expect(warnings).toHaveLength(1);
  });
});
