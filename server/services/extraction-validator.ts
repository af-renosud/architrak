import type { ParsedDocument } from "../gmail/document-parser";
import { roundCurrency, deriveTvaAmount } from "../../shared/financial-utils";

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

// TVA-neutral validator: HT + TTC are the source of truth.
// tvaAmount must equal TTC - HT (± 0.01). The parsed `tvaRate` is informational
// only and never persisted; we don't validate it as a separate equation.
export function validateExtraction(parsed: ParsedDocument): ValidationResult {
  const warnings: ValidationWarning[] = [];
  const correctedValues: Partial<ParsedDocument> = {};
  let checksRun = 0;
  let checksPassed = 0;

  const ht = parsed.amountHt;
  const ttc = parsed.amountTtc;
  const tvaAmount = parsed.tvaAmount;

  if (ht != null && ttc != null) {
    const derived = deriveTvaAmount(ht, ttc);
    if (tvaAmount != null) {
      checksRun++;
      if (Math.abs(roundCurrency(tvaAmount) - derived) > 0.01) {
        warnings.push({
          field: "tvaAmount",
          expected: derived,
          actual: tvaAmount,
          message: `TVA mismatch: TTC(${ttc}) − HT(${ht}) = ${derived}, but document shows ${tvaAmount}`,
          severity: "error",
        });
      } else {
        checksPassed++;
      }
    } else {
      // Auto-derive missing TVA so downstream consumers always have it.
      correctedValues.tvaAmount = derived;
    }
  }

  if (parsed.autoLiquidation === true) {
    checksRun++;
    let passed = true;
    if (ht != null && ttc != null && Math.abs(roundCurrency(ttc) - roundCurrency(ht)) > 0.01) {
      warnings.push({
        field: "amountTtc",
        expected: roundCurrency(ht),
        actual: ttc,
        message: `Auto-liquidation declared but TTC (${ttc}) ≠ HT (${ht})`,
        severity: "error",
      });
      passed = false;
    }
    if (tvaAmount != null && roundCurrency(tvaAmount) !== 0) {
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
