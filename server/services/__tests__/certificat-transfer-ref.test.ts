/**
 * Task #627 — Unit tests for the bank-transfer reference derivation.
 */

import { describe, it, expect } from "vitest";
import { deriveTransferRef, TRANSFER_REF_MAX_LEN } from "../certificat-transfer-ref.service";

describe("deriveTransferRef", () => {
  const base = {
    projectCode: "VERFEUIL",
    projectName: "Villa Verfeuil",
    certificateRef: "C4",
  };

  it("single invoice: format is {code} {ref} / {invoice}", () => {
    expect(
      deriveTransferRef({ ...base, invoiceNumbers: ["F-2026-138"], devisCodes: [] }),
    ).toBe("VERFEUIL C4 / F-2026-138");
  });

  it("multiple invoices: joined with ' + '", () => {
    expect(
      deriveTransferRef({ ...base, invoiceNumbers: ["F-2026-138", "F-2026-139"], devisCodes: [] }),
    ).toBe("VERFEUIL C4 / F-2026-138 + F-2026-139");
  });

  it("acompte (no invoices): falls back to devis code", () => {
    expect(
      deriveTransferRef({ ...base, invoiceNumbers: [], devisCodes: ["DEV-2026-014"] }),
    ).toBe("VERFEUIL C4 / DEV-2026-014");
  });

  it("legacy (no invoices, multiple devis): joins devis codes", () => {
    expect(
      deriveTransferRef({
        ...base,
        invoiceNumbers: [],
        devisCodes: ["DEV-2026-014", "DEV-2026-021"],
      }),
    ).toBe("VERFEUIL C4 / DEV-2026-014 + DEV-2026-021");
  });

  it("no invoice numbers AND no devis codes: returns bare base", () => {
    expect(
      deriveTransferRef({ ...base, invoiceNumbers: [], devisCodes: [] }),
    ).toBe("VERFEUIL C4");
  });

  it("falls back to project name when code is null", () => {
    const ref = deriveTransferRef({
      ...base,
      projectCode: null,
      projectName: "Villa Verfeuil",
      invoiceNumbers: ["F-2026-001"],
      devisCodes: [],
    });
    // name uppercased, spaces → hyphens, max 15 chars
    expect(ref).toBe("VILLA-VERFEUIL C4 / F-2026-001");
  });

  it("long name is sliced to 15 chars before uppercasing", () => {
    const ref = deriveTransferRef({
      projectCode: null,
      projectName: "This Is A Very Long Project Name Indeed",
      certificateRef: "C1",
      invoiceNumbers: ["F-001"],
      devisCodes: [],
    });
    // first 15 chars: "This Is A Very " → trimmed → "THIS-IS-A-VERY"
    expect(ref.startsWith("THIS-IS-A-VERY")).toBe(true);
  });

  it("preserves full project code without slicing to 15 chars", () => {
    const ref = deriveTransferRef({
      projectCode: "VERY-LONG-PROJECT-CODE-2026",
      projectName: "ignored",
      certificateRef: "C1",
      invoiceNumbers: ["F-001"],
      devisCodes: [],
    });
    expect(ref).toBe("VERY-LONG-PROJECT-CODE-2026 C1 / F-001");
  });

  it("truncates to TRANSFER_REF_MAX_LEN with ellipsis", () => {
    const longInvoiceNumbers = Array.from({ length: 20 }, (_, i) => `F-2026-${100 + i}`);
    const ref = deriveTransferRef({ ...base, invoiceNumbers: longInvoiceNumbers, devisCodes: [] });
    expect(ref.length).toBeLessThanOrEqual(TRANSFER_REF_MAX_LEN);
    expect(ref.endsWith("…")).toBe(true);
  });

  it("result fits within max when suffix is exactly at the boundary", () => {
    // "A C1 / " = 7 chars; budget for suffix = 93
    const base2 = { projectCode: "A", projectName: "A", certificateRef: "C1" };
    const suffix = "X".repeat(93);
    const ref = deriveTransferRef({ ...base2, invoiceNumbers: [suffix], devisCodes: [] });
    expect(ref.length).toBeLessThanOrEqual(TRANSFER_REF_MAX_LEN);
    expect(ref).toBe(`A C1 / ${suffix}`);
  });

  it("bare base exceeding the limit is truncated with ellipsis", () => {
    const longCode = "X".repeat(90);
    const ref = deriveTransferRef({
      projectCode: longCode,
      projectName: "ignored",
      certificateRef: "C-2026-VERY-LONG",
      invoiceNumbers: [],
      devisCodes: [],
    });
    expect(ref.length).toBeLessThanOrEqual(TRANSFER_REF_MAX_LEN);
    expect(ref.endsWith("…")).toBe(true);
  });

  it("drops the suffix gracefully when base + sep alone fill the cap", () => {
    // base = 98 chars → budget = 100 - 98 - 3 - 1 = -2 → return base only
    const longCode = "X".repeat(96);
    const ref = deriveTransferRef({
      projectCode: longCode,
      projectName: "ignored",
      certificateRef: "C1",
      invoiceNumbers: ["F-001"],
      devisCodes: [],
    });
    // base = "X*96 C1" = 99 chars < 100, so no bare-base truncation
    // budget = 100 - 99 - 3 - 1 = -3 → return base
    expect(ref).toBe(`${longCode} C1`);
    expect(ref.length).toBeLessThanOrEqual(TRANSFER_REF_MAX_LEN);
  });

  it("invoice numbers take priority over devis codes", () => {
    const ref = deriveTransferRef({
      ...base,
      invoiceNumbers: ["F-2026-138"],
      devisCodes: ["DEV-2026-014"],
    });
    expect(ref).toBe("VERFEUIL C4 / F-2026-138");
    expect(ref).not.toContain("DEV");
  });
});
