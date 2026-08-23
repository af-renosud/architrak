import type { ParsedDocument } from "../gmail/document-parser";
import { roundCurrency, deriveTvaAmount } from "../../shared/financial-utils";
import { checkExtractionCompleteness, checkFragmentLines } from "./extraction-completeness";

export interface ValidationWarning {
  field: string;
  expected: number | string | boolean;
  actual: number | string | boolean | undefined;
  message: string;
  severity: "error" | "warning";
  /** Optional structured 1-based line numbers the warning refers to (e.g.
   *  suspected fragment lines). Lets the review UI flag the exact rows
   *  without parsing the human-readable message. */
  lines?: number[];
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

  // Task #350 — deterministic completeness back-checks (page coverage,
  // text-layer evidence, numbering continuity). Runs first so blocking
  // coverage errors are always present in the returned warnings.
  warnings.push(
    ...checkExtractionCompleteness({
      coverage: parsed.extractionCoverage,
      lineItems: parsed.lineItems ?? [],
    }),
  );

  // Task #356 — zero-priced reference-less lines that survived the
  // deterministic continuation-fragment merge are flagged for review.
  warnings.push(...checkFragmentLines(parsed.lineItems ?? []));

  let checksRun = 0;
  let checksPassed = 0;
  let derivedTotalsFromLineItems = false;

  const ht = parsed.amountHt;
  const ttc = parsed.amountTtc;
  const tvaAmount = parsed.tvaAmount;
  const preTaxChargesHt = Number.isFinite(Number(parsed.preTaxChargesHt))
    ? roundCurrency(Number(parsed.preTaxChargesHt))
    : 0;

  if (ht != null && ttc != null) {
    const derived = deriveTvaAmount(roundCurrency(ht + preTaxChargesHt), ttc);
    if (tvaAmount != null) {
      checksRun++;
      if (Math.abs(roundCurrency(tvaAmount) - derived) > 0.01) {
        warnings.push({
          field: "tvaAmount",
          expected: derived,
          actual: tvaAmount,
          message: preTaxChargesHt > 0
            ? `TVA mismatch: TTC(${ttc}) − HT(${ht}) − pre-tax charges(${preTaxChargesHt}) = ${derived}, but document shows ${tvaAmount}`
            : `TVA mismatch: TTC(${ttc}) − HT(${ht}) = ${derived}, but document shows ${tvaAmount}`,
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
    const expectedAutoLiquidationTtc = ht == null
      ? null
      : roundCurrency(ht + preTaxChargesHt);
    if (
      expectedAutoLiquidationTtc != null
      && ttc != null
      && Math.abs(roundCurrency(ttc) - expectedAutoLiquidationTtc) > 0.01
    ) {
      warnings.push({
        field: "amountTtc",
        expected: expectedAutoLiquidationTtc,
        actual: ttc,
        message: preTaxChargesHt > 0
          ? `Auto-liquidation declared but TTC (${ttc}) ≠ HT plus pre-tax charges (${expectedAutoLiquidationTtc})`
          : `Auto-liquidation declared but TTC (${ttc}) ≠ HT (${ht})`,
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

  // Task #338 — Derive missing document totals from line items.
  // Seen in production (DVP0000661 / DVT0000959): the AI extracted every line
  // item correctly but returned null for amountHt/amountTtc, and the draft was
  // silently persisted as €0.00 with no warning. When BOTH document totals are
  // missing (or zero) and line items are present, derive HT from the line-item
  // sum, derive TVA/TTC when the rate is known, and attach a visible warning
  // so the operator verifies the derived figures before confirming the draft.
  // (If only one of HT/TTC is missing the existing TVA-neutral defaulting in
  // the upload services applies; this block covers the both-missing case only.)
  const htMissing = ht == null || roundCurrency(ht) === 0;
  const ttcMissing = ttc == null || roundCurrency(ttc) === 0;
  if (htMissing && ttcMissing && parsed.lineItems && parsed.lineItems.length > 0) {
    const lineSum = roundCurrency(
      parsed.lineItems.reduce((sum, item) => sum + (item.total ?? 0), 0),
    );
    if (lineSum > 0) {
      correctedValues.amountHt = lineSum;
      let derivedTtc: number | null = null;
      if (parsed.autoLiquidation === true) {
        correctedValues.tvaAmount = 0;
        derivedTtc = lineSum;
      } else if (parsed.tvaRate != null && parsed.tvaRate >= 0) {
        const derivedTva = roundCurrency(lineSum * parsed.tvaRate / 100);
        correctedValues.tvaAmount = derivedTva;
        derivedTtc = roundCurrency(lineSum + derivedTva);
      }
      if (derivedTtc != null) correctedValues.amountTtc = derivedTtc;
      derivedTotalsFromLineItems = true;
      // Task #350 — explicit advisory: derived totals are circular evidence.
      // The line-sum-vs-HT cross-check below would trivially "pass" against
      // an HT that IS the line sum, so it must never count as verification;
      // this advisory keeps that fact visible on the draft.
      warnings.push({
        field: "derivedTotals",
        expected: null as unknown as number,
        actual: lineSum,
        message:
          "Document totals were derived from the extracted line items, so the usual line-sum cross-check cannot verify them. If any line items are missing from the extraction, these totals are wrong. Verify against the PDF.",
        severity: "warning",
      });
      warnings.push({
        field: "amountHt",
        expected: lineSum,
        actual: ht ?? 0,
        message:
          `Document totals were missing from the extraction — HT derived from the sum of ${parsed.lineItems.length} line items (${lineSum})` +
          (derivedTtc != null
            ? `, TTC derived as ${derivedTtc}${parsed.autoLiquidation === true ? " (auto-liquidation)" : ` (${parsed.tvaRate}% TVA)`}`
            : "; TTC could not be derived (no TVA rate extracted)") +
          ". Verify the amounts against the PDF before confirming (line amounts may be VAT-inclusive).",
        severity: "warning",
      });
    }
  }

  // Task #350 — when the HT was derived from the line-item sum, comparing
  // the line sum back against it is circular: skip the check entirely (it
  // can neither pass nor fail meaningfully). The derivedTotals advisory
  // above already flags the situation.
  if (parsed.lineItems && parsed.lineItems.length > 0 && ht != null && !derivedTotalsFromLineItems) {
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

  let confidenceScore =
    checksRun > 0 ? Math.round((checksPassed / checksRun) * 100) : 50;
  // Derived totals are a best-effort reconstruction, not an extraction the
  // cross-checks could verify — cap confidence below the no-check default so
  // the draft visibly demands review.
  if (derivedTotalsFromLineItems) confidenceScore = Math.min(confidenceScore, 40);

  const hasErrors = warnings.some((w) => w.severity === "error");

  return {
    isValid: !hasErrors,
    warnings,
    correctedValues,
    confidenceScore,
  };
}
