import { describe, it, expect } from "vitest";
import {
  matchesFirmIdentity,
  applyFirmIdentityGate,
  rankProjectCandidates,
  isHighConfidenceProjectMatch,
  rankMilestoneCandidates,
  reconciledInvoiceTtc,
  normalizeInvoiceRef,
  type FirmProfile,
  type FeeInvoiceExtraction,
} from "../architect-fee-match";

const FIRM: FirmProfile = {
  siret: "82046676100014",
  legalNames: ["SAS ARCHITECTS-FRANCE", "ARCHITECTS-FRANCE"],
};

function extraction(overrides: Partial<FeeInvoiceExtraction> = {}): FeeInvoiceExtraction {
  return { documentType: "architect_fee_invoice", ...overrides };
}

describe("matchesFirmIdentity", () => {
  it("matches on exact SIRET regardless of name", () => {
    const v = matchesFirmIdentity({ contractorName: "Some Other Name", siret: "820 466 761 00014" }, FIRM);
    expect(v.isFirm).toBe(true);
    expect(v.reason).toContain("SIRET");
  });

  it("matches on legal name when SIRET absent", () => {
    const v = matchesFirmIdentity({ contractorName: "ARCHITECTS-FRANCE", siret: null }, FIRM);
    expect(v.isFirm).toBe(true);
  });

  it("matches legal-name variants (SAS prefix, accents/case)", () => {
    expect(matchesFirmIdentity({ contractorName: "sas architects france" }, FIRM).isFirm).toBe(true);
  });

  it("SIRET mismatch overrides a coincidental name resemblance being absent", () => {
    const v = matchesFirmIdentity({ contractorName: "BATI SUD", siret: "12345678900011" }, FIRM);
    expect(v.isFirm).toBe(false);
  });

  it("a matching legal name with a DIFFERENT valid SIRET is NOT the firm", () => {
    const v = matchesFirmIdentity({ contractorName: "SAS ARCHITECTS-FRANCE", siret: "98765432100019" }, FIRM);
    expect(v.isFirm).toBe(false);
    expect(v.reason).toContain("differs");
  });

  it("never matches on empty profile", () => {
    const v = matchesFirmIdentity({ contractorName: "ARCHITECTS-FRANCE", siret: "82046676100014" }, { siret: "", legalNames: [] });
    expect(v.isFirm).toBe(false);
  });

  it("does not match unrelated contractors", () => {
    expect(matchesFirmIdentity({ contractorName: "PLOMBERIE MARTIN" }, FIRM).isFirm).toBe(false);
  });
});

describe("applyFirmIdentityGate", () => {
  it("confirms AI architect_fee_invoice when issuer is the firm", () => {
    const r = applyFirmIdentityGate(extraction({ contractorName: "SAS ARCHITECTS-FRANCE" }), FIRM);
    expect(r.documentType).toBe("architect_fee_invoice");
    expect(r.isArchitectFeeInvoice).toBe(true);
  });

  it("downgrades AI architect_fee_invoice to invoice when issuer is NOT the firm", () => {
    const r = applyFirmIdentityGate(extraction({ contractorName: "PLOMBERIE MARTIN", siret: "12345678900011" }), FIRM);
    expect(r.documentType).toBe("invoice");
    expect(r.isArchitectFeeInvoice).toBe(false);
    expect(r.gateReason).toContain("downgraded");
  });

  it("rescues a firm-issued doc the AI typed as plain invoice", () => {
    const r = applyFirmIdentityGate(
      extraction({ documentType: "invoice", contractorName: "ARCHITECTS-FRANCE" }),
      FIRM,
    );
    expect(r.documentType).toBe("architect_fee_invoice");
    expect(r.isArchitectFeeInvoice).toBe(true);
  });

  it("rescues firm-issued acompte too", () => {
    const r = applyFirmIdentityGate(
      extraction({ documentType: "acompte", siret: "82046676100014" }),
      FIRM,
    );
    expect(r.documentType).toBe("architect_fee_invoice");
  });

  it("leaves quotations and contractor invoices untouched", () => {
    expect(applyFirmIdentityGate(extraction({ documentType: "quotation", contractorName: "BATI SUD" }), FIRM).documentType).toBe("quotation");
    expect(applyFirmIdentityGate(extraction({ documentType: "invoice", contractorName: "BATI SUD" }), FIRM).documentType).toBe("invoice");
  });
});

describe("rankProjectCandidates", () => {
  const projects = [
    { id: 1, name: "TRÜTKEN (VERFEUIL) 1358", clientName: "Heinz Hermann TRÜTKEN", siteAddress: "Verfeuil" },
    { id: 2, name: "DUPONT (NIMES) 1200", clientName: "Jean DUPONT", siteAddress: "Nîmes" },
  ];

  it("ranks the exact client-name project first with high confidence", () => {
    const ranked = rankProjectCandidates(
      extraction({ clientName: "Heinz Hermann TRÜTKEN" }),
      projects,
      "Facture-Heinz Hermann TRÜTKEN-ARCHITECTS-FRANCE-F-2026-138.pdf",
    );
    expect(ranked[0].projectId).toBe(1);
    expect(isHighConfidenceProjectMatch(ranked)).toBe(true);
  });

  it("no candidates when nothing matches", () => {
    const ranked = rankProjectCandidates(extraction({ clientName: "Inconnu Client" }), projects);
    expect(ranked).toHaveLength(0);
    expect(isHighConfidenceProjectMatch(ranked)).toBe(false);
  });

  it("close scores are not high-confidence", () => {
    const twins = [
      { id: 1, name: "A", clientName: "Martin BERNARD" },
      { id: 2, name: "B", clientName: "Martine BERNARDI" },
    ];
    const ranked = rankProjectCandidates(extraction({ clientName: "Martin BERNARD" }), twins);
    if (ranked.length > 1 && ranked[0].score - ranked[1].score < 30) {
      expect(isHighConfidenceProjectMatch(ranked)).toBe(false);
    }
  });
});

describe("milestone ranking", () => {
  const milestones = [
    { id: 10, sequence: 1, labelFr: "OUVERTURE ADMINISTRATIVE DE DOSSIER", amountTtc: "1200.00", status: "pending" },
    { id: 11, sequence: 2, labelFr: "AVANT-PROJET SOMMAIRE", amountTtc: "3600.00", status: "pending" },
    { id: 12, sequence: 3, labelFr: "PERMIS DE CONSTRUIRE", amountTtc: "1200.00", status: "paid" },
  ];

  it("exact TTC + first-in-sequence wins", () => {
    const ranked = rankMilestoneCandidates(extraction({ amountTtc: 1200.0 }), milestones);
    expect(ranked[0].milestoneId).toBe(10);
    expect(ranked[0].reasons.join(" ")).toContain("TTC");
  });

  it("paid milestones are never candidates", () => {
    const ranked = rankMilestoneCandidates(extraction({ amountTtc: 1200.0 }), milestones);
    expect(ranked.map((r) => r.milestoneId)).not.toContain(12);
  });

  it("label token overlap scores", () => {
    const ranked = rankMilestoneCandidates(
      extraction({ amountTtc: 999.99, description: "Honoraires — ouverture administrative de dossier" }),
      milestones,
    );
    expect(ranked[0].milestoneId).toBe(10);
  });

  it("reconciles TTC from HT + TVA amount and HT × rate", () => {
    expect(reconciledInvoiceTtc(extraction({ amountHt: 1000, tvaAmount: 200 }))).toBe(1200);
    expect(reconciledInvoiceTtc(extraction({ amountHt: 1000, tvaRate: 20 }))).toBe(1200);
    expect(reconciledInvoiceTtc(extraction({}))).toBeNull();
  });
});

describe("normalizeInvoiceRef", () => {
  it("normalizes case/separators for dedup", () => {
    expect(normalizeInvoiceRef("F-2026-138")).toBe(normalizeInvoiceRef("f 2026 138"));
    expect(normalizeInvoiceRef(null)).toBe("");
  });
});
