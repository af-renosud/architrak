import { describe, it, expect } from "vitest";
import {
  matchToProject,
  normalizeSiret,
  extractSirenFromTva,
  type ParsedDocument,
} from "../gmail/document-parser";
import type { Contractor, Project } from "@shared/schema";

function makeContractor(overrides: Partial<Contractor> & { id: number; name: string }): Contractor {
  return {
    id: overrides.id,
    name: overrides.name,
    siret: overrides.siret ?? null,
    address: null,
    email: null,
    phone: null,
    defaultTvaRate: "20.00",
    notes: null,
    archidocId: null,
    archidocOrphanedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Contractor;
}

const NO_PROJECTS: Project[] = [];

describe("normalizeSiret", () => {
  it("strips spaces, dots and dashes", () => {
    expect(normalizeSiret("820 466 761 00021")).toBe("82046676100021");
    expect(normalizeSiret("820.466.761.00021")).toBe("82046676100021");
    expect(normalizeSiret("820-466-761-00021")).toBe("82046676100021");
  });
  it("returns empty for nullish", () => {
    expect(normalizeSiret(null)).toBe("");
    expect(normalizeSiret(undefined)).toBe("");
    expect(normalizeSiret("")).toBe("");
  });
});

describe("extractSirenFromTva", () => {
  it("parses standard FR<key><siren>", () => {
    expect(extractSirenFromTva("FR75820466761")).toBe("820466761");
  });
  it("tolerates spaces", () => {
    expect(extractSirenFromTva("FR 75 820 466 761")).toBe("820466761");
  });
  it("falls back to 9-digit suffix when only digits present", () => {
    expect(extractSirenFromTva("75820466761")).toBe("820466761");
  });
  it("returns empty for unrecognised input", () => {
    expect(extractSirenFromTva("garbage")).toBe("");
    expect(extractSirenFromTva(null)).toBe("");
  });
});

describe("matchToProject — contractor matching", () => {
  const atTravaux = makeContractor({
    id: 42,
    name: "SAS AT TRAVAUX",
    siret: "82046676100021",
  });
  const atPiscines = makeContractor({
    id: 7,
    name: "AT PISCINES",
    siret: "12345678900012",
  });

  it("regression: AT TRAVAUX devis with SIRET 820… matches AT TRAVAUX, not AT PISCINES", async () => {
    const parsed: ParsedDocument = {
      documentType: "quotation",
      contractorName: "AT TRAVAUX",
      siret: "82046676100021",
    };
    const result = await matchToProject(parsed, NO_PROJECTS, [atPiscines, atTravaux]);
    expect(result.contractorId).toBe(42);
    expect(result.confidence).toBeGreaterThanOrEqual(100);
    expect(result.matchedFields.contractorSiret).toContain("SAS AT TRAVAUX");
    expect(result.matchedFields.contractorSiret).toContain("signal=siret");
  });

  it("SIRET exact match wins over fuzzy name and emits a disagreement advisory", async () => {
    // Document name says "AT PISCINES" (collides with contractor 7), but the
    // SIRET on the document belongs to AT TRAVAUX (id 42). SIRET wins.
    const parsed: ParsedDocument = {
      documentType: "quotation",
      contractorName: "AT PISCINES",
      siret: "82046676100021",
    };
    const result = await matchToProject(parsed, NO_PROJECTS, [atPiscines, atTravaux]);
    expect(result.contractorId).toBe(42);
    const disagreement = result.warnings.find((w) => w.field === "contractorName");
    expect(disagreement).toBeDefined();
    expect(disagreement?.message).toContain("AT TRAVAUX");
  });

  it("matches via TVA intracom when SIRET field is empty", async () => {
    const parsed: ParsedDocument = {
      documentType: "quotation",
      contractorName: "AT TRAVAUX",
      tvaIntracom: "FR75820466761",
    };
    const result = await matchToProject(parsed, NO_PROJECTS, [atPiscines, atTravaux]);
    expect(result.contractorId).toBe(42);
    expect(result.matchedFields.contractorSiret).toContain("signal=siren");
  });

  it("emits unknown_contractor advisory when SIRET is present but unmatched", async () => {
    const parsed: ParsedDocument = {
      documentType: "quotation",
      contractorName: "Some New Co",
      siret: "99999999900099",
    };
    const result = await matchToProject(parsed, NO_PROJECTS, [atPiscines, atTravaux]);
    expect(result.contractorId).toBeNull();
    const w = result.warnings.find((x) => x.field === "contractorSiret");
    expect(w).toBeDefined();
    expect(w?.message).toContain("99999999900099");
    expect(w?.message).toContain("ArchiDoc");
  });

  it("falls back to fuzzy name when no SIRET on document and contractor has no SIRET on file", async () => {
    const legacy = makeContractor({ id: 99, name: "Entreprise Dupont SARL", siret: null });
    const parsed: ParsedDocument = {
      documentType: "quotation",
      contractorName: "Entreprise Dupont SARL",
    };
    const result = await matchToProject(parsed, NO_PROJECTS, [legacy]);
    expect(result.contractorId).toBe(99);
    expect(result.matchedFields.contractorName).toContain("Entreprise Dupont SARL");
  });

  it("0.8 threshold: 'AT PISCINES' name does NOT cross-match 'AT TRAVAUX' contractor", async () => {
    // Both contractors have SIRET on file but the document is missing SIRET.
    // With the old 0.6 threshold, the name fuzzy could pick the wrong one.
    // At 0.8, the partial overlap (only "at" word, length-2 filtered) yields
    // no match → contractorId is null and the user must pick manually.
    const parsed: ParsedDocument = {
      documentType: "quotation",
      contractorName: "AT TRAVAUX",
    };
    const result = await matchToProject(parsed, NO_PROJECTS, [atPiscines]);
    expect(result.contractorId).toBeNull();
  });

  it("normalises contractor SIRET so spaces in DB don't break matching", async () => {
    const messy = makeContractor({ id: 42, name: "SAS AT TRAVAUX", siret: "820 466 761 00021" });
    const parsed: ParsedDocument = {
      documentType: "quotation",
      siret: "82046676100021",
    };
    const result = await matchToProject(parsed, NO_PROJECTS, [messy]);
    expect(result.contractorId).toBe(42);
  });

  it("returns no contractor and no warning when nothing matches and no SIRET extracted", async () => {
    const parsed: ParsedDocument = {
      documentType: "quotation",
      contractorName: "Wholly Different Co",
    };
    const result = await matchToProject(parsed, NO_PROJECTS, [atPiscines, atTravaux]);
    expect(result.contractorId).toBeNull();
    expect(result.warnings).toHaveLength(0);
  });
});
