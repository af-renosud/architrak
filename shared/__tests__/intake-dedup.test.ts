import { describe, it, expect } from "vitest";
import {
  evaluateIntakeDedup,
  normalizeRef,
  normalizeCompanyName,
  type DedupDevisRecord,
  type DedupInvoiceRecord,
} from "../intake-dedup";

const contractorNames: Record<number, string> = {
  1: "SARL Dupont Bâtiment",
  2: "Électricité Générale Martin",
};

const devisRows: DedupDevisRecord[] = [
  { id: 10, contractorId: 1, devisNumber: "DEV-2024-042", devisCode: "D-001", amountHt: "12500.00" },
  { id: 11, contractorId: 2, devisNumber: null, devisCode: "D-002", amountHt: "8000.50" },
];

const invoiceRows: DedupInvoiceRecord[] = [
  { id: 20, contractorId: 1, invoiceNumber: "FA-2024-001", amountHt: "3000.00" },
  { id: 21, contractorId: 2, invoiceNumber: "FAC 2024/002", amountHt: "1500.25" },
];

describe("normalizeRef", () => {
  it("is insensitive to case, spacing, punctuation, and accents", () => {
    expect(normalizeRef("DEV-2024/042")).toBe("dev2024042");
    expect(normalizeRef("dev 2024 042")).toBe("dev2024042");
    expect(normalizeRef("Dév.2024·042")).toBe("dev2024042");
  });
  it("returns empty string for null/undefined/empty", () => {
    expect(normalizeRef(null)).toBe("");
    expect(normalizeRef(undefined)).toBe("");
    expect(normalizeRef("  --  ")).toBe("");
  });
});

describe("normalizeCompanyName", () => {
  it("strips accents, case, punctuation and legal forms", () => {
    expect(normalizeCompanyName("SARL Dupont Bâtiment")).toBe(normalizeCompanyName("DUPONT BATIMENT sas"));
    expect(normalizeCompanyName("Électricité Générale Martin")).toBe(normalizeCompanyName("electricite-generale MARTIN"));
  });
  it("does not collapse different companies", () => {
    expect(normalizeCompanyName("Dupont Bâtiment")).not.toBe(normalizeCompanyName("Dupont Plomberie"));
  });
});

describe("evaluateIntakeDedup — quotations", () => {
  it("flags exact duplicate: same devis number + same HT amount", () => {
    const v = evaluateIntakeDedup(
      { documentType: "quotation", devisNumber: "dev 2024 042", contractorName: "Dupont Bâtiment", amountHt: 12500 },
      devisRows,
      invoiceRows,
      contractorNames,
    );
    expect(v).toMatchObject({ verdict: "duplicate", matchKind: "devis", matchId: 10 });
    if (v.verdict !== "none") expect(v.reason).toContain("DEV-2024-042");
  });

  it("matches by devisCode when devisNumber is absent on the record", () => {
    const v = evaluateIntakeDedup(
      { documentType: "quotation", reference: "d-002", amountHt: 8000.5 },
      devisRows,
      invoiceRows,
      contractorNames,
    );
    expect(v).toMatchObject({ verdict: "duplicate", matchId: 11 });
  });

  it("treats same number + different amount as a revision → review", () => {
    const v = evaluateIntakeDedup(
      { documentType: "quotation", devisNumber: "DEV-2024-042", amountHt: 13000 },
      devisRows,
      invoiceRows,
      contractorNames,
    );
    expect(v).toMatchObject({ verdict: "review", matchId: 10 });
    if (v.verdict !== "none") expect(v.reason.toLowerCase()).toContain("review before routing");
  });

  it("treats same contractor + same amount without a number match as review", () => {
    const v = evaluateIntakeDedup(
      { documentType: "quotation", devisNumber: "OTHER-999", contractorName: "dupont batiment SAS", amountHt: 12500 },
      devisRows,
      invoiceRows,
      contractorNames,
    );
    expect(v).toMatchObject({ verdict: "review", matchId: 10 });
  });

  it("compares amounts via roundCurrency (float noise tolerated)", () => {
    const v = evaluateIntakeDedup(
      { documentType: "quotation", devisNumber: "DEV-2024-042", amountHt: 12500.004 },
      devisRows,
      invoiceRows,
      contractorNames,
    );
    expect(v.verdict).toBe("duplicate");
  });

  it("still matches a voided devis (dedup covers all records regardless of status)", () => {
    const voided: DedupDevisRecord[] = [
      { id: 30, contractorId: 1, devisNumber: "DEV-VOID-7", devisCode: "D-030", amountHt: "500.00" },
    ];
    const v = evaluateIntakeDedup(
      { documentType: "quotation", devisNumber: "dev void 7", amountHt: 500 },
      voided,
      [],
      contractorNames,
    );
    expect(v).toMatchObject({ verdict: "duplicate", matchId: 30 });
  });

  it("returns none when nothing matches", () => {
    const v = evaluateIntakeDedup(
      { documentType: "quotation", devisNumber: "ZZZ-1", contractorName: "Autre Entreprise", amountHt: 999 },
      devisRows,
      invoiceRows,
      contractorNames,
    );
    expect(v.verdict).toBe("none");
  });

  it("returns none for a same-contractor different-amount partial (no money guess)", () => {
    const v = evaluateIntakeDedup(
      { documentType: "quotation", contractorName: "Dupont Bâtiment", amountHt: 111.11 },
      devisRows,
      invoiceRows,
      contractorNames,
    );
    expect(v.verdict).toBe("none");
  });

  it("never flags a duplicate on ref match alone when the extraction has no amount", () => {
    const v = evaluateIntakeDedup(
      { documentType: "quotation", devisNumber: "DEV-2024-042" },
      devisRows,
      invoiceRows,
      contractorNames,
    );
    expect(v.verdict).toBe("review");
  });
});

describe("evaluateIntakeDedup — invoices & acomptes", () => {
  it("flags exact duplicate invoice by number + amount", () => {
    const v = evaluateIntakeDedup(
      { documentType: "invoice", invoiceNumber: "fa-2024-001", amountHt: 3000 },
      devisRows,
      invoiceRows,
      contractorNames,
    );
    expect(v).toMatchObject({ verdict: "duplicate", matchKind: "invoice", matchId: 20 });
  });

  it("normalizes punctuation in invoice numbers ('FAC 2024/002' ≡ 'fac-2024.002')", () => {
    const v = evaluateIntakeDedup(
      { documentType: "acompte", invoiceNumber: "fac-2024.002", amountHt: 1500.25 },
      devisRows,
      invoiceRows,
      contractorNames,
    );
    expect(v).toMatchObject({ verdict: "duplicate", matchId: 21 });
  });

  it("same invoice number, different amount → review", () => {
    const v = evaluateIntakeDedup(
      { documentType: "invoice", invoiceNumber: "FA-2024-001", amountHt: 3100 },
      devisRows,
      invoiceRows,
      contractorNames,
    );
    expect(v).toMatchObject({ verdict: "review", matchId: 20 });
  });

  it("contractor + amount without number match → review", () => {
    const v = evaluateIntakeDedup(
      { documentType: "invoice", invoiceNumber: "UNSEEN-1", contractorName: "électricité générale martin", amountHt: 1500.25 },
      devisRows,
      invoiceRows,
      contractorNames,
    );
    expect(v).toMatchObject({ verdict: "review", matchId: 21 });
  });

  it("does not cross kinds: an invoice never matches a devis record", () => {
    const v = evaluateIntakeDedup(
      { documentType: "invoice", invoiceNumber: "DEV-2024-042", amountHt: 12500 },
      devisRows,
      [],
      contractorNames,
    );
    expect(v.verdict).toBe("none");
  });
});

describe("evaluateIntakeDedup — other document types", () => {
  it("ignores non devis/invoice types", () => {
    const v = evaluateIntakeDedup(
      { documentType: "situation", reference: "DEV-2024-042", amountHt: 12500 },
      devisRows,
      invoiceRows,
      contractorNames,
    );
    expect(v.verdict).toBe("none");
  });
});
