import { describe, it, expect } from "vitest";
import {
  roundCurrency,
  deriveTvaAmount,
  calculateAdjustedAmount,
  calculateResteARealiser,
  calculateFeeAmount,
  formatCurrencyEur,
  formatCurrencyNoSymbol,
  computeCertificatDeductions,
} from "../financial-utils";

describe("roundCurrency", () => {
  it("rounds 1.005 up to 1.01", () => {
    expect(roundCurrency(1.005)).toBe(1.01);
  });

  it("rounds 1.004 down to 1.00", () => {
    expect(roundCurrency(1.004)).toBe(1.0);
  });

  it("rounds 99.999 up to 100.00", () => {
    expect(roundCurrency(99.999)).toBe(100.0);
  });

  it("returns 0 for 0", () => {
    expect(roundCurrency(0)).toBe(0);
  });

  it("handles negative values with half-up (away from zero)", () => {
    expect(roundCurrency(-1.005)).toBe(-1.01);
    expect(roundCurrency(-1.004)).toBe(-1.0);
    expect(roundCurrency(-99.999)).toBe(-100.0);
  });

  it("preserves already-rounded values", () => {
    expect(roundCurrency(5610.92)).toBe(5610.92);
    expect(roundCurrency(1000.0)).toBe(1000.0);
  });
});

describe("deriveTvaAmount", () => {
  it("returns TTC - HT for standard 20% case", () => {
    expect(deriveTvaAmount(1000, 1200)).toBe(200.0);
  });

  it("returns 0 when HT == TTC (auto-liquidation)", () => {
    expect(deriveTvaAmount(15000, 15000)).toBe(0);
  });

  it("returns 0 when both are 0", () => {
    expect(deriveTvaAmount(0, 0)).toBe(0);
  });

  it("rounds to 2 decimals", () => {
    expect(deriveTvaAmount(5610.92, 6733.1)).toBe(1122.18);
  });

  it("handles string inputs from the database", () => {
    expect(deriveTvaAmount("1000.00", "1200.00")).toBe(200.0);
  });
});

describe("calculateAdjustedAmount (Three Buckets - Contracted)", () => {
  it("returns original when no avenants", () => {
    expect(calculateAdjustedAmount(10000, 0, 0)).toBe(10000.0);
  });

  it("adds PV only", () => {
    expect(calculateAdjustedAmount(10000, 2000, 0)).toBe(12000.0);
  });

  it("subtracts MV only", () => {
    expect(calculateAdjustedAmount(10000, 0, 1500)).toBe(8500.0);
  });

  it("handles both PV and MV", () => {
    expect(calculateAdjustedAmount(10000, 3000, 1000)).toBe(12000.0);
  });

  it("handles large values", () => {
    expect(calculateAdjustedAmount(1000000, 50000, 25000)).toBe(1025000.0);
  });

  it("handles decimal precision", () => {
    expect(calculateAdjustedAmount(5610.92, 1234.56, 789.01)).toBe(6056.47);
  });
});

describe("calculateResteARealiser (Three Buckets - Remaining)", () => {
  it("returns full amount when nothing certified", () => {
    expect(calculateResteARealiser(10000, 0)).toBe(10000.0);
  });

  it("returns partial remainder", () => {
    expect(calculateResteARealiser(10000, 6000)).toBe(4000.0);
  });

  it("returns zero when fully certified", () => {
    expect(calculateResteARealiser(10000, 10000)).toBe(0.0);
  });

  it("returns negative when over-certified (anomaly)", () => {
    expect(calculateResteARealiser(10000, 12000)).toBe(-2000.0);
  });
});

describe("calculateFeeAmount", () => {
  it("calculates 10% fee on 5610.92 HT", () => {
    expect(calculateFeeAmount(5610.92, 10)).toBe(561.09);
  });

  it("calculates 8% fee on 10000 HT", () => {
    expect(calculateFeeAmount(10000, 8)).toBe(800.0);
  });

  it("returns 0 for 0% fee rate", () => {
    expect(calculateFeeAmount(5000, 0)).toBe(0);
  });

  it("calculates 12.5% fee on 123.45 HT", () => {
    expect(calculateFeeAmount(123.45, 12.5)).toBe(15.43);
  });

  it("calculates 100% fee", () => {
    expect(calculateFeeAmount(1000, 100)).toBe(1000.0);
  });
});

describe("formatCurrencyEur", () => {
  it("formats 1000 in French EUR locale", () => {
    const result = formatCurrencyEur(1000);
    expect(result).toContain("1");
    expect(result).toContain("000");
    expect(result).toContain("\u20AC");
  });

  it("formats 0 with decimals", () => {
    const result = formatCurrencyEur(0);
    expect(result).toContain("0,00");
    expect(result).toContain("\u20AC");
  });

  it("formats negative values", () => {
    const result = formatCurrencyEur(-500);
    expect(result).toContain("500");
    expect(result).toContain("\u20AC");
  });

  it("formats decimals correctly", () => {
    const result = formatCurrencyEur(6733.1);
    expect(result).toContain("6");
    expect(result).toContain("733");
    expect(result).toContain("10");
    expect(result).toContain("\u20AC");
  });
});

describe("formatCurrencyNoSymbol", () => {
  it("formats 5610.92 with trailing euro symbol", () => {
    const result = formatCurrencyNoSymbol(5610.92);
    expect(result).toMatch(/5.610,92\s*\u20AC/);
  });

  it("formats 0 correctly", () => {
    const result = formatCurrencyNoSymbol(0);
    expect(result).toMatch(/0,00\s*\u20AC/);
  });

  it("formats large numbers with thousands separators", () => {
    const result = formatCurrencyNoSymbol(1234567.89);
    expect(result).toContain("234");
    expect(result).toContain("567");
    expect(result).toContain("89");
    expect(result).toContain("\u20AC");
  });
});

describe("computeCertificatDeductions", () => {
  const base = {
    pvMvAdjustment: 0,
    previousPayments: 0,
    retenuePercent: 5,
    hasBankGuarantee: false,
    prorataPercent: 2,
    isProrataManager: false,
    priorCumulativeRetenue: 0,
    priorCumulativeProrata: 0,
  };

  it("computes 5% retenue + 2% prorata on the gross cumulative", () => {
    const r = computeCertificatDeductions({ ...base, totalWorksHt: 100000 });
    expect(r.grossCumulativeHt).toBe(100000);
    expect(r.cumulativeRetenue).toBe(5000);
    expect(r.cumulativeProrata).toBe(2000);
    expect(r.netToPayHt).toBe(93000);
    expect(r.tvaAmount).toBe(18600);
    expect(r.netToPayTtc).toBe(111600);
  });

  it("includes PV/MV adjustment in the gross base for both deductions", () => {
    const r = computeCertificatDeductions({ ...base, totalWorksHt: 100000, pvMvAdjustment: 10000 });
    expect(r.grossCumulativeHt).toBe(110000);
    expect(r.cumulativeRetenue).toBe(5500);
    expect(r.cumulativeProrata).toBe(2200);
  });

  it("bypasses the retenue to 0 when the marché has a bank guarantee", () => {
    const r = computeCertificatDeductions({ ...base, totalWorksHt: 100000, hasBankGuarantee: true });
    expect(r.cumulativeRetenue).toBe(0);
    expect(r.cumulativeProrata).toBe(2000);
    expect(r.netToPayHt).toBe(98000);
  });

  it("exempts the prorata to 0 when the marché is the prorata manager", () => {
    const r = computeCertificatDeductions({ ...base, totalWorksHt: 100000, isProrataManager: true });
    expect(r.cumulativeProrata).toBe(0);
    expect(r.cumulativeRetenue).toBe(5000);
    expect(r.netToPayHt).toBe(95000);
  });

  it("derives the period movement as cumulative minus prior (no compounding)", () => {
    // Period 1: gross 100k → retenue 5k, prorata 2k.
    const p1 = computeCertificatDeductions({ ...base, totalWorksHt: 100000 });
    expect(p1.periodRetenue).toBe(5000);
    expect(p1.periodProrata).toBe(2000);

    // Period 2: gross now 150k cumulative; prior cumulatives carried in.
    const p2 = computeCertificatDeductions({
      ...base,
      totalWorksHt: 150000,
      previousPayments: 93000,
      priorCumulativeRetenue: p1.cumulativeRetenue,
      priorCumulativeProrata: p1.cumulativeProrata,
    });
    expect(p2.cumulativeRetenue).toBe(7500);
    expect(p2.cumulativeProrata).toBe(3000);
    // Movement is only the delta — deductions never re-charge prior periods.
    expect(p2.periodRetenue).toBe(2500);
    expect(p2.periodProrata).toBe(1000);
    expect(p2.netToPayHt).toBe(150000 - 7500 - 3000 - 93000);
  });

  it("honours an explicit architect override of either cumulative deduction", () => {
    const r = computeCertificatDeductions({
      ...base,
      totalWorksHt: 100000,
      priorCumulativeRetenue: 1000,
      priorCumulativeProrata: 500,
      retenueOverride: 4200,
      prorataOverride: 1500,
    });
    expect(r.cumulativeRetenue).toBe(4200);
    expect(r.cumulativeProrata).toBe(1500);
    expect(r.periodRetenue).toBe(3200);
    expect(r.periodProrata).toBe(1000);
  });

  it("keeps period = cumulative − prior even when the cumulative drops (downward override)", () => {
    // Prior cumulative was 5000; architect overrides this period's cumulative
    // down to 3000 → the period movement is a negative -2000, never re-charged.
    const r = computeCertificatDeductions({
      ...base,
      totalWorksHt: 100000,
      priorCumulativeRetenue: 5000,
      priorCumulativeProrata: 2000,
      retenueOverride: 3000,
      prorataOverride: 1000,
    });
    expect(r.cumulativeRetenue).toBe(3000);
    expect(r.cumulativeProrata).toBe(1000);
    expect(r.periodRetenue).toBe(-2000);
    expect(r.periodProrata).toBe(-1000);
  });

  it("treats a zero override as a real value, not as 'use the rate'", () => {
    const r = computeCertificatDeductions({
      ...base,
      totalWorksHt: 100000,
      retenueOverride: 0,
    });
    expect(r.cumulativeRetenue).toBe(0);
    expect(r.cumulativeProrata).toBe(2000);
  });
});
