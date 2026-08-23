import { roundCurrency } from "../../shared/financial-utils";
import {
  recoverPlanningSummaryLineItemsFromPdf,
  type ParsedDocument,
  type PlanningSummaryExcludedGroupCandidate,
  type PlanningSummaryRecoveryEvidence,
  type PlanningSummaryLineCandidate,
  type PlanningSummaryTotalsCandidate,
} from "../gmail/document-parser";
import {
  validateExtraction,
  type ValidationResult,
  type ValidationWarning,
} from "./extraction-validator";

type RecoveryFn = (
  pdfBuffer: Buffer,
  fileName: string,
  context: {
    expectedHt: number;
    lineItemsTotal: number;
    difference: number;
    lineItems: Array<{
      index: number;
      description: string;
      totalHt: number;
    }>;
  },
) => Promise<PlanningSummaryRecoveryEvidence | PlanningSummaryLineCandidate[]>;

export interface RecoverPlanningTotalsBoxLinesInput {
  pdfBuffer: Buffer;
  fileName: string;
  parsed: ParsedDocument;
  validation: ValidationResult;
  recoverCandidates?: RecoveryFn;
}

export interface RecoverPlanningTotalsBoxLinesResult {
  parsed: ParsedDocument;
  validation: ValidationResult;
}

function sumLineItems(parsed: ParsedDocument): number {
  return roundCurrency(
    (parsed.lineItems ?? []).reduce((sum, item) => sum + (Number(item.total) || 0), 0),
  );
}

function normalizeDescription(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function lineFingerprint(description: string, total: number): string {
  return `${normalizeDescription(description)}|${roundCurrency(total).toFixed(2)}`;
}

function validBbox(
  value: PlanningSummaryLineCandidate["bbox"],
): value is { x: number; y: number; w: number; h: number } {
  if (!value) return false;
  const coordinates = [value.x, value.y, value.w, value.h];
  return coordinates.every((coordinate) => Number.isFinite(coordinate) && coordinate >= 0 && coordinate <= 1)
    && value.w > 0
    && value.h > 0
    && value.x + value.w <= 1.001
    && value.y + value.h <= 1.001;
}

function unresolvedMismatchWarning(
  expectedHt: number,
  actualLineTotal: number,
  recoveryStatus: "partial" | "none" | "failed",
): ValidationWarning {
  const statusMessage = recoveryStatus === "failed"
    ? "The targeted summary/totals-box search could not complete."
    : recoveryStatus === "partial"
      ? "The targeted summary/totals-box search found option evidence but could not safely reconcile every row."
      : "The targeted summary/totals-box search found no unambiguous evidence-backed option correction.";
  const arithmeticMessage = actualLineTotal === expectedHt
    ? `Planning line items total (${actualLineTotal}) matches the quotation HT total arithmetically, but the option-selection evidence is not safe to apply.`
    : `Planning line items total (${actualLineTotal}) does not equal the quotation HT total (${expectedHt}).`;
  return {
    field: "lineItems",
    expected: expectedHt,
    actual: actualLineTotal,
    message: `${arithmeticMessage} ${statusMessage} Verify the PDF before review.`,
    severity: "warning",
  };
}

function replaceLineMismatchWarning(
  validation: ValidationResult,
  warning: ValidationWarning,
): ValidationResult {
  return {
    ...validation,
    warnings: [
      ...validation.warnings.filter((item) => item.field !== "lineItems"),
      warning,
    ],
    confidenceScore: Math.min(validation.confidenceScore, 79),
  };
}

function normalizeRecoveryEvidence(
  value: PlanningSummaryRecoveryEvidence | PlanningSummaryLineCandidate[],
): PlanningSummaryRecoveryEvidence {
  if (Array.isArray(value)) {
    return { lines: value, excludedGroups: [] };
  }
  return {
    lines: Array.isArray(value?.lines) ? value.lines : [],
    excludedGroups: Array.isArray(value?.excludedGroups) ? value.excludedGroups : [],
    ...(value?.totals ? { totals: value.totals } : {}),
    ...(Number.isInteger(value?.unsafeEvidenceCount) && Number(value.unsafeEvidenceCount) > 0
      ? { unsafeEvidenceCount: Number(value.unsafeEvidenceCount) }
      : {}),
  };
}

function normalizeLineIndexes(
  value: unknown,
  itemCount: number,
): number[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const indexes = value.map(Number);
  if (
    indexes.some((index) => !Number.isInteger(index) || index < 1 || index > itemCount)
  ) {
    return null;
  }
  const unique = Array.from(new Set(indexes)).sort((a, b) => a - b);
  if (unique.length !== indexes.length) return null;
  for (let index = 1; index < unique.length; index++) {
    if (unique[index] !== unique[index - 1] + 1) return null;
  }
  return unique;
}

function sumIndexedLineItems(
  items: NonNullable<ParsedDocument["lineItems"]>,
  indexes: number[],
): number {
  return roundCurrency(
    indexes.reduce((sum, index) => sum + (Number(items[index - 1]?.total) || 0), 0),
  );
}

function validTotalsCandidate(
  candidate: PlanningSummaryTotalsCandidate | undefined,
): PlanningSummaryTotalsCandidate | null {
  if (!candidate || typeof candidate.evidenceText !== "string" || candidate.evidenceText.trim().length < 3) {
    return null;
  }
  const normalized: PlanningSummaryTotalsCandidate = {
    amountHt: roundCurrency(Number(candidate.amountHt)),
    preTaxChargesHt: roundCurrency(Number(candidate.preTaxChargesHt)),
    tvaAmount: roundCurrency(Number(candidate.tvaAmount)),
    amountTtc: roundCurrency(Number(candidate.amountTtc)),
    evidenceText: candidate.evidenceText.trim(),
  };
  if (
    !Number.isFinite(normalized.amountHt)
    || normalized.amountHt <= 0
    || !Number.isFinite(normalized.preTaxChargesHt)
    || normalized.preTaxChargesHt < 0
    || !Number.isFinite(normalized.tvaAmount)
    || normalized.tvaAmount < 0
    || !Number.isFinite(normalized.amountTtc)
    || normalized.amountTtc <= 0
  ) {
    return null;
  }
  const additiveTotal = roundCurrency(
    normalized.amountHt + normalized.preTaxChargesHt + normalized.tvaAmount,
  );
  if (Math.abs(additiveTotal - normalized.amountTtc) > 0.02) return null;
  if (candidate.tvaRate != null) {
    const tvaRate = Number(candidate.tvaRate);
    if (!Number.isFinite(tvaRate) || tvaRate < 0 || tvaRate > 100) return null;
    const expectedTva = roundCurrency(
      (normalized.amountHt + normalized.preTaxChargesHt) * tvaRate / 100,
    );
    if (Math.abs(expectedTva - normalized.tvaAmount) > 0.02) return null;
    normalized.tvaRate = tvaRate;
  }
  if (typeof candidate.pageHint === "number" && Number.isInteger(candidate.pageHint) && candidate.pageHint > 0) {
    normalized.pageHint = candidate.pageHint;
    if (validBbox(candidate.bbox)) normalized.bbox = candidate.bbox;
  }
  return normalized;
}

function isValidRetainedCandidate(
  candidate: PlanningSummaryLineCandidate,
): boolean {
  return typeof candidate.description === "string"
    && candidate.description.trim().length > 0
    && Number.isFinite(Number(candidate.totalHt))
    && roundCurrency(Number(candidate.totalHt)) > 0
    && candidate.includedInTotal === true
    && typeof candidate.amountBasis === "string"
    && candidate.amountBasis.trim().toUpperCase() === "HT"
    && typeof candidate.evidenceText === "string"
    && candidate.evidenceText.trim().length >= 3;
}

function isValidExcludedCandidate(
  candidate: PlanningSummaryExcludedGroupCandidate,
): boolean {
  return typeof candidate.description === "string"
    && candidate.description.trim().length > 0
    && Number.isFinite(Number(candidate.totalHt))
    && roundCurrency(Number(candidate.totalHt)) > 0
    && candidate.excludedFromTotal === true
    && typeof candidate.amountBasis === "string"
    && candidate.amountBasis.trim().toUpperCase() === "HT"
    && typeof candidate.evidenceText === "string"
    && candidate.evidenceText.trim().length >= 3;
}

export async function recoverPlanningTotalsBoxLines(
  input: RecoverPlanningTotalsBoxLinesInput,
): Promise<RecoverPlanningTotalsBoxLinesResult> {
  const originalExpectedHt = input.parsed.amountHt == null
    ? null
    : roundCurrency(Number(input.parsed.amountHt));
  const initialLineItemsTotal = sumLineItems(input.parsed);

  if (
    originalExpectedHt == null
    || !Number.isFinite(originalExpectedHt)
    || originalExpectedHt <= 0
    || input.parsed.documentType !== "quotation"
    || !input.parsed.lineItems?.length
    || input.parsed.lineItemsVatCheck?.vatInclusive === true
  ) {
    return { parsed: input.parsed, validation: input.validation };
  }

  const initialDifference = roundCurrency(originalExpectedHt - initialLineItemsTotal);
  const recoverCandidates = input.recoverCandidates ?? recoverPlanningSummaryLineItemsFromPdf;
  let evidence: PlanningSummaryRecoveryEvidence = { lines: [], excludedGroups: [] };
  let recoveryFailed = false;

  try {
    evidence = normalizeRecoveryEvidence(await recoverCandidates(input.pdfBuffer, input.fileName, {
      expectedHt: originalExpectedHt,
      lineItemsTotal: initialLineItemsTotal,
      difference: initialDifference,
      lineItems: input.parsed.lineItems.map((item, index) => ({
        index: index + 1,
        description: item.description,
        totalHt: roundCurrency(Number(item.total) || 0),
      })),
    }));
  } catch (error) {
    recoveryFailed = true;
    console.warn(
      "[PlanningExtraction] totals-box recovery failed; preserving verification-required draft:",
      error instanceof Error ? error.message : String(error),
    );
  }

  const existingItems = input.parsed.lineItems.map((item) => ({ ...item }));
  let ambiguousCandidateCount = evidence.unsafeEvidenceCount ?? 0;
  const correctedTotals = validTotalsCandidate(evidence.totals);
  let exclusionSafetyFailed = ambiguousCandidateCount > 0;
  if (evidence.totals && !correctedTotals) {
    ambiguousCandidateCount++;
    exclusionSafetyFailed = true;
  }
  const expectedHt = correctedTotals?.amountHt ?? originalExpectedHt;
  const difference = roundCurrency(expectedHt - initialLineItemsTotal);
  const fingerprintIndexes = new Map<string, number[]>();
  existingItems.forEach((item, index) => {
    const fingerprint = lineFingerprint(item.description, Number(item.total) || 0);
    const indexes = fingerprintIndexes.get(fingerprint) ?? [];
    indexes.push(index + 1);
    fingerprintIndexes.set(fingerprint, indexes);
  });
  // A totals box may repeat a body row using an abbreviated description. If
  // the amount is already present, its identity is ambiguous and it is safer
  // to leave the draft flagged than to count the same printed option twice.
  const usedAmounts = new Set(
    existingItems.map((item) => roundCurrency(Number(item.total) || 0).toFixed(2)),
  );
  const recoveredItems: NonNullable<ParsedDocument["lineItems"]> = [];
  const recoveredEvidence: NonNullable<ParsedDocument["planningSummaryRecovery"]>["recoveredEvidence"] = [];
  const retainedIndexes = new Set<number>();
  let matchedRetainedCount = 0;
  let runningTotal = initialLineItemsTotal;

  for (const rawCandidate of evidence.lines as unknown[]) {
    if (
      typeof rawCandidate !== "object"
      || rawCandidate === null
      || Array.isArray(rawCandidate)
    ) {
      ambiguousCandidateCount++;
      exclusionSafetyFailed = true;
      continue;
    }
    const candidate = rawCandidate as PlanningSummaryLineCandidate;
    if (!isValidRetainedCandidate(candidate)) {
      ambiguousCandidateCount++;
      exclusionSafetyFailed = true;
      continue;
    }
    const description = typeof candidate.description === "string"
      ? candidate.description.trim()
      : "";
    const totalHt = roundCurrency(Number(candidate.totalHt));
    const evidenceText = typeof candidate.evidenceText === "string"
      ? candidate.evidenceText.trim()
      : "";
    const matchedIndexes = normalizeLineIndexes(
      candidate.matchedLineItemIndexes,
      existingItems.length,
    );
    if (candidate.matchedLineItemIndexes != null) {
      if (
        !matchedIndexes
        || sumIndexedLineItems(existingItems, matchedIndexes) !== totalHt
        || matchedIndexes.some((index) => retainedIndexes.has(index))
      ) {
        ambiguousCandidateCount++;
        exclusionSafetyFailed = true;
        continue;
      }
      matchedIndexes.forEach((index) => retainedIndexes.add(index));
      matchedRetainedCount++;
      recoveredEvidence.push({
        description,
        totalHt,
        evidenceText,
        action: "matched",
        lineItemIndexes: matchedIndexes,
        ...(typeof candidate.pageHint === "number" && Number.isInteger(candidate.pageHint) && candidate.pageHint > 0
          ? {
              pageHint: candidate.pageHint,
              ...(validBbox(candidate.bbox) ? { bbox: candidate.bbox } : {}),
            }
          : {}),
      });
      continue;
    }

    const fingerprint = lineFingerprint(description, totalHt);
    const exactMatchIndexes = fingerprintIndexes.get(fingerprint) ?? [];
    if (exactMatchIndexes.length > 1) {
      exactMatchIndexes.forEach((index) => retainedIndexes.add(index));
      ambiguousCandidateCount++;
      exclusionSafetyFailed = true;
      continue;
    }
    if (exactMatchIndexes.length === 1) {
      retainedIndexes.add(exactMatchIndexes[0]);
      matchedRetainedCount++;
      recoveredEvidence.push({
        description,
        totalHt,
        evidenceText,
        action: "matched",
        lineItemIndexes: exactMatchIndexes,
        ...(typeof candidate.pageHint === "number" && Number.isInteger(candidate.pageHint) && candidate.pageHint > 0
          ? {
              pageHint: candidate.pageHint,
              ...(validBbox(candidate.bbox) ? { bbox: candidate.bbox } : {}),
            }
          : {}),
      });
      continue;
    }
    const amountKey = totalHt.toFixed(2);
    if (usedAmounts.has(amountKey)) {
      ambiguousCandidateCount++;
      exclusionSafetyFailed = true;
      continue;
    }

    const remaining = roundCurrency(expectedHt - runningTotal);
    // Evidence-backed candidates still may not overshoot the known HT total.
    // Arithmetic is a safety check here, not a source for creating a line.
    if (totalHt > remaining) {
      ambiguousCandidateCount++;
      exclusionSafetyFailed = true;
      continue;
    }

    const recovered: NonNullable<ParsedDocument["lineItems"]>[number] = {
      description,
      total: totalHt,
    };
    if (
      typeof candidate.pageHint === "number"
      && Number.isInteger(candidate.pageHint)
      && candidate.pageHint > 0
    ) {
      recovered.pageHint = candidate.pageHint;
      if (validBbox(candidate.bbox)) recovered.bbox = candidate.bbox;
    }
    recoveredItems.push(recovered);
    recoveredEvidence.push({
      description,
      totalHt,
      evidenceText,
      action: "added",
      ...(recovered.pageHint != null ? { pageHint: recovered.pageHint } : {}),
      ...(recovered.bbox != null ? { bbox: recovered.bbox } : {}),
    });
    fingerprintIndexes.set(fingerprint, [existingItems.length + recoveredItems.length]);
    usedAmounts.add(amountKey);
    runningTotal = roundCurrency(runningTotal + totalHt);
  }

  const proposedExcludedIndexes = new Set<number>();
  const proposedExcludedEvidence: NonNullable<ParsedDocument["planningSummaryRecovery"]>["excludedEvidence"] = [];
  let proposedExcludedTotal = 0;
  for (const rawCandidate of evidence.excludedGroups as unknown[]) {
    if (
      typeof rawCandidate !== "object"
      || rawCandidate === null
      || Array.isArray(rawCandidate)
    ) {
      ambiguousCandidateCount++;
      exclusionSafetyFailed = true;
      continue;
    }
    const candidate = rawCandidate as PlanningSummaryExcludedGroupCandidate;
    if (!isValidExcludedCandidate(candidate)) {
      ambiguousCandidateCount++;
      exclusionSafetyFailed = true;
      continue;
    }
    const indexes = normalizeLineIndexes(candidate.lineItemIndexes, existingItems.length);
    const totalHt = roundCurrency(Number(candidate.totalHt));
    if (
      !indexes
      || sumIndexedLineItems(existingItems, indexes) !== totalHt
      || indexes.some((index) => retainedIndexes.has(index) || proposedExcludedIndexes.has(index))
    ) {
      ambiguousCandidateCount++;
      exclusionSafetyFailed = true;
      continue;
    }
    indexes.forEach((index) => proposedExcludedIndexes.add(index));
    proposedExcludedTotal = roundCurrency(proposedExcludedTotal + totalHt);
    proposedExcludedEvidence.push({
      description: candidate.description.trim(),
      totalHt,
      evidenceText: candidate.evidenceText.trim(),
      lineItemIndexes: indexes,
      ...(typeof candidate.pageHint === "number" && Number.isInteger(candidate.pageHint) && candidate.pageHint > 0
        ? {
            pageHint: candidate.pageHint,
            ...(validBbox(candidate.bbox) ? { bbox: candidate.bbox } : {}),
          }
        : {}),
    });
  }

  // Exclusions are all-or-nothing. Evidence can identify alternatives, but we
  // only remove them when the complete proposed set exactly reconciles HT.
  const exclusionsExactlyReconcile = proposedExcludedIndexes.size > 0
    && !exclusionSafetyFailed
    && roundCurrency(runningTotal - proposedExcludedTotal) === expectedHt;
  if (proposedExcludedIndexes.size > 0 && !exclusionsExactlyReconcile) {
    exclusionSafetyFailed = true;
  }
  const applyExclusions = exclusionsExactlyReconcile;
  const excludedIndexes = applyExclusions ? proposedExcludedIndexes : new Set<number>();
  const excludedEvidence = applyExclusions ? proposedExcludedEvidence : [];
  const excludedTotal = applyExclusions ? proposedExcludedTotal : 0;
  const finalItems = [
    ...existingItems.filter((_item, index) => !excludedIndexes.has(index + 1)),
    ...recoveredItems,
  ];
  const finalLineItemsTotal = roundCurrency(runningTotal - excludedTotal);
  const reconciled = finalLineItemsTotal === expectedHt
    && !exclusionSafetyFailed
    && !recoveryFailed;
  const status = recoveryFailed
    ? "failed" as const
    : reconciled
      ? "reconciled" as const
      : recoveredItems.length > 0 || applyExclusions || correctedTotals != null
        ? "partial" as const
        : "none" as const;
  const recoveredTotal = roundCurrency(
    recoveredItems.reduce((sum, item) => sum + (Number(item.total) || 0), 0),
  );
  const parsed: ParsedDocument = {
    ...input.parsed,
    ...(correctedTotals
      ? {
          amountHt: correctedTotals.amountHt,
          amountTtc: correctedTotals.amountTtc,
          tvaAmount: correctedTotals.tvaAmount,
          preTaxChargesHt: correctedTotals.preTaxChargesHt,
          ...(correctedTotals.tvaRate != null ? { tvaRate: correctedTotals.tvaRate } : {}),
        }
      : {}),
    lineItems: finalItems,
    planningSummaryRecovery: {
      attempted: true,
      status,
      originalExpectedHt,
      expectedHt,
      initialLineItemsTotal,
      difference,
      candidateCount: evidence.lines.length + evidence.excludedGroups.length,
      recoveredCount: recoveredItems.length,
      matchedRetainedCount,
      excludedCount: excludedIndexes.size,
      ambiguousCandidateCount,
      recoveredTotal,
      excludedTotal,
      finalLineItemsTotal,
      recoveredEvidence,
      excludedEvidence,
      ...(correctedTotals ? { correctedTotals } : {}),
      note: reconciled
        ? `Reconciled retained quotation options: added ${recoveredItems.length}, matched ${matchedRetainedCount}, and excluded ${excludedIndexes.size} evidence-backed line item(s).`
        : "Summary/totals-box evidence did not fully reconcile the HT line total; human verification remains required.",
    },
  };
  delete parsed.lineItemsVatCheck;

  let validation = validateExtraction(parsed);
  if (!reconciled) {
    const unresolvedStatus: "partial" | "none" | "failed" =
      status === "reconciled" ? "none" : status;
    validation = replaceLineMismatchWarning(
      validation,
      unresolvedMismatchWarning(expectedHt, finalLineItemsTotal, unresolvedStatus),
    );
  }

  return { parsed, validation };
}