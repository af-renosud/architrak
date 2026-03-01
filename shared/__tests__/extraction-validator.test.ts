import { describe, it, expect } from "vitest";
import { validateExtraction } from "../../server/services/extraction-validator";
import type { ParsedDocument } from "../../server/gmail/document-parser";
import { roundCurrency, calculateTtc, calculateTva } from "../financial-utils";

function doc(overrides: Partial<ParsedDocument> = {}): ParsedDocument {
  return { documentType: "invoice", ...overrides };
}

describe("extraction-validator", () => {
  describe("HT + TVA = TTC cross-check", () => {
    it("passes when HT + TVA = TTC", () => {
      const result = validateExtraction(doc({
        amountHt: 10000,
        tvaRate: 20,
        amountTtc: 12000,
      }));
      expect(result.isValid).toBe(true);
      expect(result.warnings.filter(w => w.field === "amountTtc")).toHaveLength(0);
    });

    it("flags error when HT + TVA != TTC", () => {
      const result = validateExtraction(doc({
        amountHt: 10000,
        tvaRate: 20,
        amountTtc: 11500,
      }));
      expect(result.isValid).toBe(false);
      const ttcWarning = result.warnings.find(w => w.field === "amountTtc" && w.severity === "error");
      expect(ttcWarning).toBeDefined();
      expect(ttcWarning!.expected).toBe(12000);
      expect(ttcWarning!.actual).toBe(11500);
    });

    it("passes with real-world rounding (small precision difference)", () => {
      const result = validateExtraction(doc({
        amountHt: 1234.56,
        tvaRate: 20,
        amountTtc: 1481.47,
      }));
      expect(result.isValid).toBe(true);
    });
  });

  describe("TVA amount cross-check", () => {
    it("passes when TVA amount matches HT * rate", () => {
      const result = validateExtraction(doc({
        amountHt: 5000,
        tvaRate: 20,
        tvaAmount: 1000,
        amountTtc: 6000,
      }));
      expect(result.isValid).toBe(true);
      expect(result.warnings.filter(w => w.field === "tvaAmount")).toHaveLength(0);
    });

    it("flags error when TVA amount is wrong", () => {
      const result = validateExtraction(doc({
        amountHt: 5000,
        tvaRate: 20,
        tvaAmount: 900,
        amountTtc: 6000,
      }));
      expect(result.isValid).toBe(false);
      const tvaWarning = result.warnings.find(w => w.field === "tvaAmount" && w.severity === "error");
      expect(tvaWarning).toBeDefined();
      expect(tvaWarning!.expected).toBe(1000);
      expect(tvaWarning!.actual).toBe(900);
    });
  });

  describe("auto-correction of missing values", () => {
    it("auto-calculates TTC when missing but HT + rate present", () => {
      const result = validateExtraction(doc({
        amountHt: 8000,
        tvaRate: 20,
      }));
      expect(result.correctedValues.amountTtc).toBe(calculateTtc(8000, 20));
      expect(result.correctedValues.amountTtc).toBe(9600);
    });

    it("auto-calculates HT when missing but TTC + rate present", () => {
      const result = validateExtraction(doc({
        amountTtc: 12000,
        tvaRate: 20,
      }));
      expect(result.correctedValues.amountHt).toBe(10000);
    });

    it("auto-calculates TVA amount when missing", () => {
      const result = validateExtraction(doc({
        amountHt: 5000,
        tvaRate: 10,
      }));
      expect(result.correctedValues.tvaAmount).toBe(500);
    });

    it("does not auto-correct when values are already present", () => {
      const result = validateExtraction(doc({
        amountHt: 5000,
        tvaRate: 20,
        amountTtc: 6000,
        tvaAmount: 1000,
      }));
      expect(result.correctedValues.amountTtc).toBeUndefined();
      expect(result.correctedValues.amountHt).toBeUndefined();
    });
  });

  describe("auto-liquidation validation", () => {
    it("passes when auto-liquidation has tvaRate=0 and tvaAmount=0", () => {
      const result = validateExtraction(doc({
        autoLiquidation: true,
        tvaRate: 0,
        tvaAmount: 0,
        amountHt: 15000,
        amountTtc: 15000,
      }));
      expect(result.isValid).toBe(true);
      expect(result.warnings.filter(w => w.field === "tvaRate")).toHaveLength(0);
    });

    it("flags error when auto-liquidation but tvaRate is non-zero", () => {
      const result = validateExtraction(doc({
        autoLiquidation: true,
        tvaRate: 20,
        amountHt: 15000,
      }));
      expect(result.isValid).toBe(false);
      const warning = result.warnings.find(w => w.field === "tvaRate" && w.severity === "error");
      expect(warning).toBeDefined();
      expect(warning!.message).toContain("Auto-liquidation");
    });

    it("flags error when auto-liquidation but tvaAmount is non-zero", () => {
      const result = validateExtraction(doc({
        autoLiquidation: true,
        tvaRate: 0,
        tvaAmount: 500,
        amountHt: 15000,
      }));
      expect(result.isValid).toBe(false);
      const warning = result.warnings.find(w => w.field === "tvaAmount" && w.severity === "error");
      expect(warning).toBeDefined();
    });

    it("does not flag when autoLiquidation is false", () => {
      const result = validateExtraction(doc({
        autoLiquidation: false,
        tvaRate: 20,
        tvaAmount: 1000,
        amountHt: 5000,
        amountTtc: 6000,
      }));
      expect(result.isValid).toBe(true);
    });
  });

  describe("line items total check", () => {
    it("passes when line items sum matches HT", () => {
      const result = validateExtraction(doc({
        amountHt: 3000,
        tvaRate: 20,
        amountTtc: 3600,
        lineItems: [
          { description: "Plomberie", total: 1500 },
          { description: "Electricite", total: 1500 },
        ],
      }));
      expect(result.isValid).toBe(true);
    });

    it("flags warning when line items total differs from HT by more than 1.00", () => {
      const result = validateExtraction(doc({
        amountHt: 3000,
        tvaRate: 20,
        amountTtc: 3600,
        lineItems: [
          { description: "Plomberie", total: 1500 },
          { description: "Electricite", total: 1000 },
        ],
      }));
      const warning = result.warnings.find(w => w.field === "lineItems");
      expect(warning).toBeDefined();
      expect(warning!.severity).toBe("warning");
    });

    it("passes when line items total differs from HT by less than 1.00", () => {
      const result = validateExtraction(doc({
        amountHt: 3000,
        tvaRate: 20,
        amountTtc: 3600,
        lineItems: [
          { description: "Plomberie", total: 1500 },
          { description: "Electricite", total: 1499.50 },
        ],
      }));
      const warning = result.warnings.find(w => w.field === "lineItems");
      expect(warning).toBeUndefined();
    });
  });

  describe("retenue de garantie check", () => {
    it("passes when RG is ~5% of TTC", () => {
      const result = validateExtraction(doc({
        amountHt: 10000,
        tvaRate: 20,
        amountTtc: 12000,
        retenueDeGarantie: 600,
      }));
      const warning = result.warnings.find(w => w.field === "retenueDeGarantie");
      expect(warning).toBeUndefined();
    });

    it("flags warning when RG is far from 5% of TTC", () => {
      const result = validateExtraction(doc({
        amountHt: 10000,
        tvaRate: 20,
        amountTtc: 12000,
        retenueDeGarantie: 1500,
      }));
      const warning = result.warnings.find(w => w.field === "retenueDeGarantie");
      expect(warning).toBeDefined();
      expect(warning!.severity).toBe("warning");
    });
  });

  describe("net a payer check", () => {
    it("passes when netAPayer equals TTC minus RG", () => {
      const result = validateExtraction(doc({
        amountHt: 10000,
        tvaRate: 20,
        amountTtc: 12000,
        retenueDeGarantie: 600,
        netAPayer: 11400,
      }));
      const warning = result.warnings.find(w => w.field === "netAPayer");
      expect(warning).toBeUndefined();
    });

    it("flags warning when netAPayer does not match TTC - RG", () => {
      const result = validateExtraction(doc({
        amountHt: 10000,
        tvaRate: 20,
        amountTtc: 12000,
        retenueDeGarantie: 600,
        netAPayer: 10000,
      }));
      const warning = result.warnings.find(w => w.field === "netAPayer");
      expect(warning).toBeDefined();
      expect(warning!.severity).toBe("warning");
    });

    it("uses TTC as expected netAPayer when no RG", () => {
      const result = validateExtraction(doc({
        amountHt: 10000,
        tvaRate: 20,
        amountTtc: 12000,
        netAPayer: 12000,
      }));
      const warning = result.warnings.find(w => w.field === "netAPayer");
      expect(warning).toBeUndefined();
    });
  });

  describe("confidence score", () => {
    it("returns 100 when all checks pass", () => {
      const result = validateExtraction(doc({
        amountHt: 10000,
        tvaRate: 20,
        amountTtc: 12000,
        tvaAmount: 2000,
      }));
      expect(result.confidenceScore).toBe(100);
    });

    it("returns 50 when no checks are applicable", () => {
      const result = validateExtraction(doc({}));
      expect(result.confidenceScore).toBe(50);
    });

    it("returns partial score when some checks fail", () => {
      const result = validateExtraction(doc({
        amountHt: 10000,
        tvaRate: 20,
        amountTtc: 11000,
        tvaAmount: 2000,
      }));
      expect(result.confidenceScore).toBe(50);
      expect(result.confidenceScore).toBeGreaterThan(0);
      expect(result.confidenceScore).toBeLessThan(100);
    });
  });
});
