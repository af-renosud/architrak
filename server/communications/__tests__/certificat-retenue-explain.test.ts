import { describe, it, expect } from "vitest";
import { buildRetenueExplainText } from "../certificat-generator";

/**
 * Task #485 — the client-facing Retenue de Garantie explanation must never
 * state a rate (or a bank-guarantee reason) that the certificat's persisted
 * amounts do not corroborate: architect amount-overrides win over the marché
 * rate in the deduction resolver and leave no provenance on the row.
 */
describe("buildRetenueExplainText", () => {
  const base = {
    retenuePercent: 5,
    hasBankGuarantee: false,
    grossCumulativeHt: 24500,
    cumulativeRetenue: 1225, // exactly 5%
    isSolde: false,
    retenueReleased: false,
  };

  it("states the rate when the persisted amount matches the marché rate", () => {
    expect(buildRetenueExplainText(base)).toContain("retention of 5%");
  });

  it("states a non-default rate when it matches (e.g. 3%)", () => {
    expect(
      buildRetenueExplainText({ ...base, retenuePercent: 3, cumulativeRetenue: 735 }),
    ).toContain("retention of 3%");
  });

  it("falls back to amount-based wording when an override made the amount diverge", () => {
    const text = buildRetenueExplainText({ ...base, cumulativeRetenue: 800 });
    expect(text).not.toMatch(/\d+(\.\d+)?%/);
    expect(text).toContain("\u201CRetenue de Garantie\u201D line above");
  });

  it("never claims a rate when the configured rate is zero but an amount was withheld (override)", () => {
    const text = buildRetenueExplainText({ ...base, retenuePercent: 0, cumulativeRetenue: 500 });
    expect(text).not.toMatch(/\d+(\.\d+)?%/);
  });

  it("explains the bank guarantee only when one exists and nothing is withheld", () => {
    expect(
      buildRetenueExplainText({ ...base, hasBankGuarantee: true, retenuePercent: 0, cumulativeRetenue: 0 }),
    ).toContain("bank guarantee");
  });

  it("zero withheld without a guarantee stays neutral (no guarantee claim, no rate)", () => {
    const text = buildRetenueExplainText({ ...base, cumulativeRetenue: 0 });
    expect(text).not.toContain("bank guarantee");
    expect(text).not.toMatch(/\d+(\.\d+)?%/);
    expect(text).toContain("No retenue de garantie");
  });

  it("solde release wording is rate-neutral and mentions the release line", () => {
    const text = buildRetenueExplainText({
      ...base,
      isSolde: true,
      retenueReleased: true,
      cumulativeRetenue: 0,
    });
    expect(text).toContain("released on this final (solde) certificat");
    expect(text).toContain("Lib\u00E9ration Retenue de Garantie");
    expect(text).not.toMatch(/\d+(\.\d+)?%/);
  });

  it("solde with retention still withheld does not use release wording", () => {
    const text = buildRetenueExplainText({ ...base, isSolde: true });
    expect(text).not.toContain("released on this final");
    expect(text).toContain("retention of 5%");
  });
});
