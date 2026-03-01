import { describe, it, expect } from "vitest";
import {
  roundCurrency,
  calculateTva,
  calculateTtc,
  calculateHtFromTtc,
  calculateAdjustedAmount,
  calculateResteARealiser,
  calculateFeeAmount,
  calculateFeeTtc,
  formatCurrencyEur,
  formatCurrencyNoSymbol,
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

describe("calculateTva", () => {
  it("calculates 20% TVA on 1000 HT", () => {
    expect(calculateTva(1000, 20)).toBe(200.0);
  });

  it("calculates 10% reduced rate on 1000 HT", () => {
    expect(calculateTva(1000, 10)).toBe(100.0);
  });

  it("calculates 5.5% rate on 1000 HT", () => {
    expect(calculateTva(1000, 5.5)).toBe(55.0);
  });

  it("returns 0 for zero HT amount", () => {
    expect(calculateTva(0, 20)).toBe(0);
  });

  it("calculates 20% TVA on 5610.92 HT with 2dp rounding", () => {
    expect(calculateTva(5610.92, 20)).toBe(1122.18);
  });

  it("returns 0 for zero rate", () => {
    expect(calculateTva(1000, 0)).toBe(0);
  });
});

describe("calculateTtc", () => {
  it("calculates TTC at 20% for 1000 HT", () => {
    expect(calculateTtc(1000, 20)).toBe(1200.0);
  });

  it("calculates TTC at 20% for 5610.92 HT with 2dp rounding", () => {
    expect(calculateTtc(5610.92, 20)).toBe(6733.1);
  });

  it("returns same as HT for 0% rate", () => {
    expect(calculateTtc(1000, 0)).toBe(1000.0);
  });

  it("calculates TTC at 5.5% for 1000 HT", () => {
    expect(calculateTtc(1000, 5.5)).toBe(1055.0);
  });

  it("returns 0 for zero HT", () => {
    expect(calculateTtc(0, 20)).toBe(0);
  });
});

describe("calculateHtFromTtc", () => {
  it("reverses 1200 TTC at 20% to 1000 HT", () => {
    expect(calculateHtFromTtc(1200, 20)).toBe(1000.0);
  });

  it("roundtrip: calculateTtc then calculateHtFromTtc returns original", () => {
    const original = 5610.92;
    const ttc = calculateTtc(original, 20);
    const recovered = calculateHtFromTtc(ttc, 20);
    expect(recovered).toBe(original);
  });

  it("returns same as TTC for 0% rate", () => {
    expect(calculateHtFromTtc(1000, 0)).toBe(1000.0);
  });

  it("returns 0 for zero TTC", () => {
    expect(calculateHtFromTtc(0, 20)).toBe(0);
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

describe("calculateFeeTtc", () => {
  it("calculates TTC on 561.09 fee at 20%", () => {
    expect(calculateFeeTtc(561.09, 20)).toBe(673.31);
  });

  it("returns 0 for zero fee", () => {
    expect(calculateFeeTtc(0, 20)).toBe(0);
  });

  it("returns same as HT for 0% rate", () => {
    expect(calculateFeeTtc(561.09, 0)).toBe(561.09);
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
