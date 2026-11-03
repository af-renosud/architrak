import { describe, expect, it } from "vitest";
import { parseMoneyInput } from "../money-input";
import { externalWorkInput } from "../external-works";

describe("pasted euro amounts", () => {
  it.each(["€ 18 703,07", "18\u202f703,07 €", "18\u00a0703,07", "18703,07",
    "18703.07", "18,703.07", "18.703,07", "18'703.07", "18’703,07",
    "EUR 18 703,07", "18 703,07 EUR", "\n€ 18 703,07\r\n"])("parses %s exactly", raw => {
    expect(parseMoneyInput(raw)).toEqual({ kind: "valid", value: "18703.07" });
  });
  it.each([["0", "0.00"], ["00042,5", "42.50"], ["1 234", "1234.00"],
    ["1,234,567", "1234567.00"], ["1.234.567,89", "1234567.89"],
    ["9 999 999 999,99", "9999999999.99"]])("normalizes %s", (raw, value) => {
    expect(parseMoneyInput(raw)).toEqual({ kind: "valid", value });
  });
  it.each(["", "-123", "(123)", "$123", "123 USD", "€123€", "EUR €123",
    "12 34,56", "1,23,456", "1.234.56", "18 703,077", "0,123", "10000.123",
    "10\t20", "10\n20", "10 + 20", "1e3", "Infinity", "99999999999.99"])("rejects %s without rounding", raw => {
    expect(parseMoneyInput(raw).kind).toBe("invalid");
  });
  it.each(["1,234", "1.234"])("requires explicit grouping confirmation for %s", raw => {
    expect(parseMoneyInput(raw)).toMatchObject({ kind: "ambiguous", candidate: "1234.00" });
  });
  it("shares exact parsing and TTC checks with the server schema", () => {
    const input = { reference: "EXT-1", description: "Works", confirmedCompleted: true,
      amountHt: "€ 18 703,07", amountTtc: "22,443.68" };
    expect(externalWorkInput.parse(input)).toMatchObject({ amountHt: "18703.07", amountTtc: "22443.68" });
    expect(externalWorkInput.safeParse({ ...input, amountTtc: "18 703,06" }).success).toBe(false);
    expect(externalWorkInput.safeParse({ ...input, amountHt: "1,234" }).success).toBe(false);
  });
});
