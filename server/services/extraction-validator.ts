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

// Common French VAT rates (%). Used only to recognise a line-item sum that is
// VAT-inclusive when the TTC itself was not extracted; never used to rewrite
// amounts.
const COMMON_FRENCH_VAT_RATES = [20, 10, 5.5, 2.1];

// Tolerance shared with the HT comparison: per-line rounding accumulates, so
// ±1.00 (same as the primary check) is used for the VAT-inclusive detection.
const LINE_TOTAL_TOLERANCE = 1.0;

function detectVatInclusiveLineTotal(
  roundedLineTotal: number,
  roundedHt: number,
  ttc: number | undefined,
  tvaAmount: number | undefined,
): { matchedAgainst: "ttc" | "ht_plus_tva" | "ht_times_rate"; note: string } | null {
  if (ttc != null && Math.abs(roundedLineTotal - roundCurrency(ttc)) <= LINE_TOTAL_TOLERANCE) {
    return {
      matchedAgainst: "ttc",
      note: `Line items sum (${roundedLineTotal}) matches the document TTC (${roundCurrency(ttc)}) — line amounts are VAT-inclusive, not an extraction error.`,
    };
  }
  if (tvaAmount != null && Math.abs(roundedLineTotal - roundCurrency(roundedHt + tvaAmount)) <= LINE_TOTAL_TOLERANCE) {
    return {
      matchedAgainst: "ht_plus_tva",
      note: `Line items sum (${roundedLineTotal}) matches HT + TVA (${roundCurrency(roundedHt + tvaAmount)}) — line amounts are VAT-inclusive, not an extraction error.`,
    };
  }
  // Rate-guessing fallback is only safe when the document supplied neither a
  // TTC nor a TVA figure to check against — otherwise a sum that happens to
  // equal HT × 1.10 while the document says 20% VAT is a genuine anomaly.
  if (ttc != null || tvaAmount != null) return null;
  for (const rate of COMMON_FRENCH_VAT_RATES) {
    const htTimesRate = roundCurrency(roundedHt * (1 + rate / 100));
    if (Math.abs(roundedLineTotal - htTimesRate) <= LINE_TOTAL_TOLERANCE) {
      return {
        matchedAgainst: "ht_times_rate",
        note: `Line items sum (${roundedLineTotal}) matches HT × ${(1 + rate / 100).toFixed(3)} (${rate}% VAT) — line amounts are VAT-inclusive, not an extraction error.`,
      };
    }
  }
  return null;
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
      // Before flagging a mismatch, check whether the line totals are simply
      // VAT-inclusive (TTC) amounts. French quotations often print per-line
      // TTC figures, and the extractor sometimes copies those; the document
      // itself is arithmetically correct in that case (seen on DVP0000785:
      // lines summed to TTC, diff vs HT was exactly the 20% VAT).
      const vatInclusiveMatch = detectVatInclusiveLineTotal(
        roundedLineTotal,
        roundedHt,
        ttc,
        tvaAmount,
      );
      if (vatInclusiveMatch) {
        checksPassed++;
        // Stamp the audit note directly on `parsed` (same pattern as
        // siretCrossCheck): every consumer persists `aiExtractedData: parsed`,
        // so this is the only way the note reliably reaches stored
        // extractedData. Also mirrored into correctedValues for flows that
        // persist the merged view.
        parsed.lineItemsVatCheck = {
          vatInclusive: true,
          lineItemsTotal: roundedLineTotal,
          matchedAgainst: vatInclusiveMatch.matchedAgainst,
          note: vatInclusiveMatch.note,
        };
        correctedValues.lineItemsVatCheck = parsed.lineItemsVatCheck;
      } else {
        warnings.push({
          field: "lineItems",
          expected: roundedHt,
          actual: roundedLineTotal,
          message: `Line items total (${roundedLineTotal}) differs from HT (${roundedHt}) by ${roundCurrency(Math.abs(roundedLineTotal - roundedHt))} — and does not match TTC either`,
          severity: "warning",
        });
      }
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
