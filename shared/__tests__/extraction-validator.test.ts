import { describe, it, expect } from "vitest";
import { validateExtraction } from "../../server/services/extraction-validator";
import type { ParsedDocument } from "../../server/gmail/document-parser";

function doc(overrides: Partial<ParsedDocument> = {}): ParsedDocument {
  return { documentType: "invoice", ...overrides };
}

describe("extraction-validator (TVA-neutral)", () => {
  describe("tvaAmount cross-check (TTC - HT)", () => {
    it("passes when tvaAmount matches TTC - HT", () => {
      const result = validateExtraction(doc({
        amountHt: 5000,
        amountTtc: 6000,
        tvaAmount: 1000,
      }));
      expect(result.isValid).toBe(true);
      expect(result.warnings.filter(w => w.field === "tvaAmount")).toHaveLength(0);
    });

    it("flags error when tvaAmount does not match TTC - HT", () => {
      const result = validateExtraction(doc({
        amountHt: 5000,
        amountTtc: 6000,
        tvaAmount: 900,
      }));
      expect(result.isValid).toBe(false);
      const tvaWarning = result.warnings.find(w => w.field === "tvaAmount" && w.severity === "error");
      expect(tvaWarning).toBeDefined();
      expect(tvaWarning!.expected).toBe(1000);
      expect(tvaWarning!.actual).toBe(900);
    });

    it("passes with real-world rounding (small precision difference)", () => {
      const result = validateExtraction(doc({
        amountHt: 1234.56,
        amountTtc: 1481.47,
        tvaAmount: 246.91,
      }));
      expect(result.isValid).toBe(true);
    });
  });

  describe("auto-derivation of tvaAmount", () => {
    it("auto-derives tvaAmount when missing but HT and TTC present", () => {
      const result = validateExtraction(doc({
        amountHt: 8000,
        amountTtc: 9600,
      }));
      expect(result.correctedValues.tvaAmount).toBe(1600);
    });

    it("auto-derives tvaAmount = 0 for auto-liquidation when HT == TTC", () => {
      const result = validateExtraction(doc({
        amountHt: 15000,
        amountTtc: 15000,
      }));
      expect(result.correctedValues.tvaAmount).toBe(0);
    });

    it("does not auto-correct when tvaAmount already present", () => {
      const result = validateExtraction(doc({
        amountHt: 5000,
        amountTtc: 6000,
        tvaAmount: 1000,
      }));
      expect(result.correctedValues.tvaAmount).toBeUndefined();
    });
  });

  describe("auto-liquidation validation", () => {
    it("passes when auto-liquidation has TTC == HT and tvaAmount=0", () => {
      const result = validateExtraction(doc({
        autoLiquidation: true,
        amountHt: 15000,
        amountTtc: 15000,
        tvaAmount: 0,
      }));
      expect(result.isValid).toBe(true);
      expect(result.warnings.filter(w => w.severity === "error")).toHaveLength(0);
    });

    it("flags error when auto-liquidation but TTC != HT", () => {
      const result = validateExtraction(doc({
        autoLiquidation: true,
        amountHt: 15000,
        amountTtc: 18000,
      }));
      expect(result.isValid).toBe(false);
      const warning = result.warnings.find(w => w.field === "amountTtc" && w.severity === "error");
      expect(warning).toBeDefined();
      expect(warning!.message).toContain("Auto-liquidation");
    });

    it("flags error when auto-liquidation but tvaAmount is non-zero", () => {
      const result = validateExtraction(doc({
        autoLiquidation: true,
        amountHt: 15000,
        amountTtc: 15000,
        tvaAmount: 500,
      }));
      expect(result.isValid).toBe(false);
      const warning = result.warnings.find(w => w.field === "tvaAmount" && w.severity === "error");
      expect(warning).toBeDefined();
    });

    it("does not flag when autoLiquidation is false", () => {
      const result = validateExtraction(doc({
        autoLiquidation: false,
        amountHt: 5000,
        amountTtc: 6000,
        tvaAmount: 1000,
      }));
      expect(result.isValid).toBe(true);
    });
  });

  describe("line items total check", () => {
    it("passes when line items sum matches HT", () => {
      const result = validateExtraction(doc({
        amountHt: 3000,
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
        amountTtc: 12000,
        retenueDeGarantie: 600,
      }));
      const warning = result.warnings.find(w => w.field === "retenueDeGarantie");
      expect(warning).toBeUndefined();
    });

    it("flags warning when RG is far from 5% of TTC", () => {
      const result = validateExtraction(doc({
        amountHt: 10000,
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
        amountTtc: 12000,
        tvaAmount: 2000,
      }));
      expect(result.confidenceScore).toBe(100);
    });

    it("returns 50 when no checks are applicable", () => {
      const result = validateExtraction(doc({}));
      expect(result.confidenceScore).toBe(50);
    });

    it("returns partial score when some checks pass and some fail", () => {
      // tvaAmount mismatch (fail) + lineItems matching HT (pass) = 1/2 = 50
      const result = validateExtraction(doc({
        amountHt: 3000,
        amountTtc: 3600,
        tvaAmount: 700,
        lineItems: [
          { description: "Plomberie", total: 1500 },
          { description: "Electricite", total: 1500 },
        ],
      }));
      expect(result.confidenceScore).toBeGreaterThan(0);
      expect(result.confidenceScore).toBeLessThan(100);
    });
  });
});
