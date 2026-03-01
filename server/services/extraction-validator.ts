import type { ParsedDocument } from "../gmail/document-parser";
import {
  roundCurrency,
  calculateTva,
  calculateTtc,
  calculateHtFromTtc,
} from "../../shared/financial-utils";

export interface ValidationWarning {
  field: string;
  expected: number | string | boolean;
  actual: number | string | boolean | undefined;
  message: string;
  severity: "error" | "warning";
}

export interface ValidationResult {
  isValid: boolean;
  warnings: ValidationWarning[];
  correctedValues: Partial<ParsedDocument>;
  confidenceScore: number;
}

export function validateExtraction(parsed: ParsedDocument): ValidationResult {
  const warnings: ValidationWarning[] = [];
  const correctedValues: Partial<ParsedDocument> = {};
  let checksRun = 0;
  let checksPassed = 0;

  const ht = parsed.amountHt;
  const ttc = parsed.amountTtc;
  const tvaRate = parsed.tvaRate;
  const tvaAmount = parsed.tvaAmount;

  if (ht != null && tvaRate != null && ttc != null) {
    checksRun++;
    const expectedTtc = calculateTtc(ht, tvaRate);
    if (Math.abs(expectedTtc - roundCurrency(ttc)) > 0.01) {
      warnings.push({
        field: "amountTtc",
        expected: expectedTtc,
        actual: ttc,
        message: `TTC mismatch: HT(${ht}) + TVA@${tvaRate}% = ${expectedTtc}, but document shows ${ttc}`,
        severity: "error",
      });
    } else {
      checksPassed++;
    }
  }

  if (ht != null && tvaRate != null && tvaAmount != null) {
    checksRun++;
    const expectedTva = calculateTva(ht, tvaRate);
    if (Math.abs(expectedTva - roundCurrency(tvaAmount)) > 0.01) {
      warnings.push({
        field: "tvaAmount",
        expected: expectedTva,
        actual: tvaAmount,
        message: `TVA mismatch: HT(${ht}) × ${tvaRate}% = ${expectedTva}, but document shows ${tvaAmount}`,
        severity: "error",
      });
    } else {
      checksPassed++;
    }
  }

  if (ttc == null && ht != null && tvaRate != null) {
    const calculated = calculateTtc(ht, tvaRate);
    correctedValues.amountTtc = calculated;
    warnings.push({
      field: "amountTtc",
      expected: calculated,
      actual: undefined,
      message: `TTC missing — auto-calculated as ${calculated} from HT(${ht}) + TVA@${tvaRate}%`,
      severity: "warning",
    });
  }

  if (ht == null && ttc != null && tvaRate != null) {
    const calculated = calculateHtFromTtc(ttc, tvaRate);
    correctedValues.amountHt = calculated;
    warnings.push({
      field: "amountHt",
      expected: calculated,
      actual: undefined,
      message: `HT missing — auto-calculated as ${calculated} from TTC(${ttc}) / (1 + ${tvaRate}%)`,
      severity: "warning",
    });
  }

  if (tvaAmount == null && ht != null && tvaRate != null) {
    const calculated = calculateTva(ht, tvaRate);
    correctedValues.tvaAmount = calculated;
  }

  if (parsed.autoLiquidation === true) {
    checksRun++;
    let passed = true;
    if (tvaRate != null && tvaRate !== 0) {
      warnings.push({
        field: "tvaRate",
        expected: 0,
        actual: tvaRate,
        message: `Auto-liquidation declared but TVA rate is ${tvaRate}% — should be 0`,
        severity: "error",
      });
      passed = false;
    }
    if (tvaAmount != null && tvaAmount !== 0) {
      warnings.push({
        field: "tvaAmount",
        expected: 0,
        actual: tvaAmount,
        message: `Auto-liquidation declared but TVA amount is ${tvaAmount} — should be 0`,
        severity: "error",
      });
      passed = false;
    }
    if (passed) checksPassed++;
  }

  if (parsed.lineItems && parsed.lineItems.length > 0 && ht != null) {
    checksRun++;
    const lineTotal = parsed.lineItems.reduce(
      (sum, item) => sum + (item.total ?? 0),
      0,
    );
    const roundedLineTotal = roundCurrency(lineTotal);
    const roundedHt = roundCurrency(ht);
    if (Math.abs(roundedLineTotal - roundedHt) > 1.0) {
      warnings.push({
        field: "lineItems",
        expected: roundedHt,
        actual: roundedLineTotal,
        message: `Line items total (${roundedLineTotal}) differs from HT (${roundedHt}) by ${roundCurrency(Math.abs(roundedLineTotal - roundedHt))}`,
        severity: "warning",
      });
    } else {
      checksPassed++;
    }
  }

  if (parsed.retenueDeGarantie != null && ttc != null) {
    checksRun++;
    const expectedRg = roundCurrency(ttc * 0.05);
    const actualRg = roundCurrency(parsed.retenueDeGarantie);
    if (Math.abs(actualRg - expectedRg) > roundCurrency(ttc * 0.01)) {
      warnings.push({
        field: "retenueDeGarantie",
        expected: expectedRg,
        actual: actualRg,
        message: `Retenue de garantie (${actualRg}) differs from expected 5% of TTC (${expectedRg})`,
        severity: "warning",
      });
    } else {
      checksPassed++;
    }
  }

  if (parsed.netAPayer != null && ttc != null) {
    checksRun++;
    const rg = parsed.retenueDeGarantie ?? 0;
    const expectedNet = roundCurrency(ttc - rg);
    const actualNet = roundCurrency(parsed.netAPayer);
    if (Math.abs(actualNet - expectedNet) > 0.01) {
      warnings.push({
        field: "netAPayer",
        expected: expectedNet,
        actual: actualNet,
        message: `Net à payer (${actualNet}) differs from TTC(${ttc}) - RG(${rg}) = ${expectedNet}`,
        severity: "warning",
      });
    } else {
      checksPassed++;
    }
  }

  const confidenceScore =
    checksRun > 0 ? Math.round((checksPassed / checksRun) * 100) : 50;

  const hasErrors = warnings.some((w) => w.severity === "error");

  return {
    isValid: !hasErrors,
    warnings,
    correctedValues,
    confidenceScore,
  };
}
