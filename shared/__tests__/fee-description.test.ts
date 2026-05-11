import { describe, it, expect } from "vitest";
import {
  buildFeeInvoiceDescription,
  bucketAgeDays,
  summarizeOutstandingFees,
  type OutstandingFeeEntry,
} from "../fee-description";

describe("buildFeeInvoiceDescription", () => {
  it("builds the canonical paragraph with French-formatted amounts", () => {
    const desc = buildFeeInvoiceDescription({
      contractorName: "ENTREPRISE DUPONT SARL",
      invoiceNumber: "F-2026-0042",
      devisCode: "DEV-2026-001-A",
      amountHt: 12345.67,
      amountTtc: 14814.8,
      feePercentage: 8,
    });
    expect(desc).toBe(
      "Architects' Project Management Fees against contractor: ENTREPRISE DUPONT SARL " +
        "and references as follows: " +
        "Invoice: F-2026-0042. " +
        "Corresponding signed Devis: DEV-2026-001-A. " +
        "Contractor's total invoice value TTC: 14\u202F814,80 \u20AC. " +
        "Contractor's total invoice value HT: 12\u202F345,67 \u20AC. " +
        "Project management fees are calculated as 8% x contractor's invoice " +
        "12\u202F345,67 \u20AC = 987,65 \u20AC HT.",
    );
  });

  it("computes fee HT through calculateFeeAmount (rounded 2dp)", () => {
    // 1234.56 * 8.5% = 104.9376 -> rounds to 104.94
    const desc = buildFeeInvoiceDescription({
      contractorName: "ACME",
      invoiceNumber: "1",
      devisCode: "D-1",
      amountHt: 1234.56,
      amountTtc: 1481.47,
      feePercentage: 8.5,
    });
    expect(desc).toContain("= 104,94 \u20AC HT");
    expect(desc).toContain("8.5%");
  });

  it("substitutes safe placeholders for null/empty contractor, invoice, and devis", () => {
    const desc = buildFeeInvoiceDescription({
      contractorName: null,
      invoiceNumber: "",
      devisCode: null,
      amountHt: 100,
      amountTtc: 120,
      feePercentage: 10,
    });
    expect(desc).toContain("(unknown contractor)");
    expect(desc).toContain("Invoice: (no invoice number)");
    expect(desc).toContain("Corresponding signed Devis: (no devis reference)");
  });

  it("formats integer rates without decimals", () => {
    const desc = buildFeeInvoiceDescription({
      contractorName: "X", invoiceNumber: "I", devisCode: "D",
      amountHt: 100, amountTtc: 120, feePercentage: 10,
    });
    expect(desc).toContain("10% x");
  });
});

describe("bucketAgeDays", () => {
  it.each([
    [0, "0-30"], [30, "0-30"],
    [31, "31-60"], [60, "31-60"],
    [61, "61-90"], [90, "61-90"],
    [91, "90+"], [365, "90+"],
  ])("buckets %i days into %s", (days, label) => {
    expect(bucketAgeDays(days)).toBe(label);
  });
});

describe("summarizeOutstandingFees", () => {
  const entry = (id: number, ageDays: number, feeAmountHt: number): OutstandingFeeEntry => ({
    entryId: id, feeId: 1, projectId: 1,
    projectName: "P", projectCode: "PC",
    contractorName: "C", invoiceId: id, invoiceNumber: `F-${id}`,
    devisId: id, devisCode: `D-${id}`,
    amountHt: 1000, amountTtc: 1200, feePercentage: 8,
    feeAmountHt, createdAt: new Date().toISOString(), ageDays,
  });

  it("aggregates totals and buckets", () => {
    const summary = summarizeOutstandingFees([
      entry(1, 5, 80),
      entry(2, 45, 100),
      entry(3, 80, 50),
      entry(4, 200, 30),
      entry(5, 10, 20.005),
    ]);
    expect(summary.totalCount).toBe(5);
    expect(summary.totalFeeHt).toBe(280.01);
    const byLabel = Object.fromEntries(summary.buckets.map((b) => [b.label, b]));
    expect(byLabel["0-30"].count).toBe(2);
    expect(byLabel["0-30"].totalFeeHt).toBe(100.01);
    expect(byLabel["31-60"].count).toBe(1);
    expect(byLabel["61-90"].count).toBe(1);
    expect(byLabel["90+"].count).toBe(1);
  });

  it("returns zeros when no entries", () => {
    const summary = summarizeOutstandingFees([]);
    expect(summary.totalCount).toBe(0);
    expect(summary.totalFeeHt).toBe(0);
    expect(summary.buckets).toHaveLength(4);
    expect(summary.buckets.every((b) => b.count === 0 && b.totalFeeHt === 0)).toBe(true);
  });
});
