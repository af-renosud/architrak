import { describe, it, expect } from "vitest";
import {
  extractLabelledProjectIdentityFromTextLayer,
  extractPaidAcompteFromTextLayer,
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
    notes: null,
    archidocId: null,
    archidocOrphanedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Contractor;
}

const NO_PROJECTS: Project[] = [];

function makeProject(overrides: Partial<Project> & { id: number; name: string; code: string }): Project {
  return {
    id: overrides.id,
    name: overrides.name,
    code: overrides.code,
    clientName: "Client test",
    status: "active",
    archivedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Project;
}

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
    const disagreement = result.warnings.find((w) => w.field === "contractor_identity_mismatch");
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
    const w = result.warnings.find((x) => x.field === "unknown_contractor");
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

  it("unknown SIRET wins over a fuzzy-matchable contractor name (no silent fallback)", async () => {
    // Regression: even though "SAS AT TRAVAUX" is a perfect fuzzy match for the
    // contractor name on the document, the SIRET extracted from the PDF doesn't
    // match any contractor in the DB. The matcher MUST NOT silently assign
    // the fuzzy-name candidate — that would re-introduce the AT TRAVAUX /
    // AT PISCINES regression in reverse.
    const parsed: ParsedDocument = {
      documentType: "quotation",
      contractorName: "SAS AT TRAVAUX",
      siret: "99999999900099",
    };
    const result = await matchToProject(parsed, NO_PROJECTS, [atTravaux, atPiscines]);
    expect(result.contractorId).toBeNull();
    const advisory = result.warnings.find((w) => w.field === "unknown_contractor");
    expect(advisory).toBeDefined();
  });

  it("short-name hardening: 4-char brand 'BETO' does NOT cross-match contractor 'BETON SARL'", async () => {
    // Without the dynamic length-based threshold, fuzzyMatch's `includes()`
    // branch returns 0.9 here (one normalised string contains the other).
    // 0.9 ≥ 0.8 fixed threshold, so the old code would pick the wrong row.
    const beton = makeContractor({ id: 1, name: "BETON SARL", siret: null });
    const parsed: ParsedDocument = {
      documentType: "quotation",
      contractorName: "BETO",
    };
    const result = await matchToProject(parsed, NO_PROJECTS, [beton]);
    expect(result.contractorId).toBeNull();
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

describe("matchToProject — labelled project identity", () => {
  const trutken = makeProject({
    id: 1358,
    name: "TRÜTKEN (VERFEUIL) 1358",
    code: "1358",
  });

  it("assigns the complete labelled TRÜTKEN (VERFEUIL) 1358 project name", async () => {
    const result = await matchToProject(
      { documentType: "quotation", projectName: "TRÜTKEN (VERFEUIL) 1358" },
      [trutken],
      [],
    );
    expect(result.projectId).toBe(1358);
    expect(result.matchedFields.projectIdentity).toContain("TRÜTKEN (VERFEUIL) 1358");
    expect(result.matchedFields.projectIdentity).toContain("exactly matches live project");
  });

  it("matches accent, punctuation and parenthesis variations deterministically", async () => {
    const result = await matchToProject(
      { documentType: "invoice", projectName: "Trutken - Verfeuil / 1358" },
      [trutken],
      [],
    );
    expect(result.projectId).toBe(1358);
  });

  it("assigns an explicitly labelled project reference/code", async () => {
    const result = await matchToProject(
      { documentType: "invoice", projectReference: "1358" },
      [trutken],
      [],
    );
    expect(result.projectId).toBe(1358);
    expect(result.matchedFields.projectIdentity).toContain("project reference");
  });

  it("does not assign from a partial or weak labelled project text", async () => {
    const result = await matchToProject(
      { documentType: "quotation", projectName: "TRUTKEN VERFEUIL" },
      [trutken],
      [],
    );
    expect(result.projectId).toBeNull();
  });

  it("does not assign a duplicated normalized project identity", async () => {
    const duplicate = makeProject({
      id: 99,
      name: "Trutken Verfeuil 1358",
      code: "OTHER",
    });
    const result = await matchToProject(
      { documentType: "quotation", projectName: "TRÜTKEN (VERFEUIL) 1358" },
      [trutken, duplicate],
      [],
    );
    expect(result.projectId).toBeNull();
    expect(result.warnings.some((warning) => warning.field === "project_identity_ambiguous")).toBe(true);
  });

  it("never assigns an archived project from labelled identity", async () => {
    const archived = makeProject({ ...trutken, id: 14, archivedAt: new Date() });
    const result = await matchToProject(
      { documentType: "quotation", projectName: archived.name },
      [archived],
      [],
    );
    expect(result.projectId).toBeNull();
  });

  it("assigns nothing when labelled project name and reference conflict", async () => {
    const other = makeProject({ id: 77, name: "Maison Martin", code: "MARTIN-77" });
    const result = await matchToProject(
      {
        documentType: "quotation",
        projectName: trutken.name,
        projectReference: other.code,
      },
      [trutken, other],
      [],
    );
    expect(result.projectId).toBeNull();
    expect(result.matchedFields.projectIdentity).toContain("no project assigned");
  });

  it("fails closed when one labelled identity matches and another is unknown", async () => {
    const result = await matchToProject(
      {
        documentType: "invoice",
        projectName: trutken.name,
        projectReference: "TYPO-UNKNOWN",
      },
      [trutken],
      [],
    );
    expect(result.projectId).toBeNull();
    expect(result.warnings.some((warning) => warning.field === "project_identity_ambiguous")).toBe(true);
  });
});

describe("deterministic text-layer intake evidence", () => {
  it("extracts an accented labelled project identity without relying on AI", () => {
    expect(
      extractLabelledProjectIdentityFromTextLayer([
        "FACTURE FR25.26-0144\nChantier : TRÜTKEN (VERFEUIL) 1358\nRéférence projet : 1358",
      ]),
    ).toEqual({
      projectName: "TRÜTKEN (VERFEUIL) 1358",
      projectReference: "1358",
    });
  });

  it("ignores an unlabelled project-looking phrase", () => {
    expect(
      extractLabelledProjectIdentityFromTextLayer(["Travaux réalisés chez TRÜTKEN (VERFEUIL) 1358"]),
    ).toEqual({ projectName: undefined, projectReference: undefined });
  });

  it("extracts the TTC amount from an explicit paid-deposit line", () => {
    expect(extractPaidAcompteFromTextLayer(["Acompte versé        1\u202f488,00 €"])).toEqual({
      amountTtc: 1488,
      evidenceText: "Acompte versé 1 488,00 €",
    });
  });

  it("does not treat a requested deposit as a paid deposit", () => {
    expect(extractPaidAcompteFromTextLayer(["Acompte à verser : 1 488,00 €"])).toBeNull();
  });
});
