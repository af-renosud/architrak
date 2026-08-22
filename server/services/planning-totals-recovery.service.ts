import { roundCurrency } from "../../shared/financial-utils";
import {
  recoverPlanningSummaryLineItemsFromPdf,
  type ParsedDocument,
  type PlanningSummaryLineCandidate,
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
  },
) => Promise<PlanningSummaryLineCandidate[]>;

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
      ? "The targeted summary/totals-box search found some printed options but did not fully reconcile the quotation."
      : "The targeted summary/totals-box search found no additional evidence-backed HT option rows.";
  return {
    field: "lineItems",
    expected: expectedHt,
    actual: actualLineTotal,
    message:
      `Planning line items total (${actualLineTotal}) does not equal the quotation HT total (${expectedHt}). ${statusMessage} Verify the remaining difference against the PDF before review.`,
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

export async function recoverPlanningTotalsBoxLines(
  input: RecoverPlanningTotalsBoxLinesInput,
): Promise<RecoverPlanningTotalsBoxLinesResult> {
  const expectedHt = input.parsed.amountHt == null
    ? null
    : roundCurrency(Number(input.parsed.amountHt));
  const initialLineItemsTotal = sumLineItems(input.parsed);

  if (
    expectedHt == null
    || !Number.isFinite(expectedHt)
    || expectedHt <= 0
    || input.parsed.documentType !== "quotation"
    || !input.parsed.lineItems?.length
    || expectedHt === initialLineItemsTotal
    || input.parsed.lineItemsVatCheck?.vatInclusive === true
  ) {
    return { parsed: input.parsed, validation: input.validation };
  }

  // Missing positive option rows can only explain a line sum below HT. A sum
  // above HT needs human correction (or the existing VAT-inclusive handling),
  // never a fabricated negative/balancing line.
  if (initialLineItemsTotal > expectedHt) {
    return { parsed: input.parsed, validation: input.validation };
  }

  const difference = roundCurrency(expectedHt - initialLineItemsTotal);
  const recoverCandidates = input.recoverCandidates ?? recoverPlanningSummaryLineItemsFromPdf;
  let candidates: PlanningSummaryLineCandidate[] = [];
  let recoveryFailed = false;

  try {
    candidates = await recoverCandidates(input.pdfBuffer, input.fileName, {
      expectedHt,
      lineItemsTotal: initialLineItemsTotal,
      difference,
    });
  } catch (error) {
    recoveryFailed = true;
    console.warn(
      "[PlanningExtraction] totals-box recovery failed; preserving verification-required draft:",
      error instanceof Error ? error.message : String(error),
    );
  }

  const existingItems = input.parsed.lineItems.map((item) => ({ ...item }));
  const fingerprints = new Set(
    existingItems.map((item) => lineFingerprint(item.description, Number(item.total) || 0)),
  );
  // A totals box may repeat a body row using an abbreviated description. If
  // the amount is already present, its identity is ambiguous and it is safer
  // to leave the draft flagged than to count the same printed option twice.
  const usedAmounts = new Set(
    existingItems.map((item) => roundCurrency(Number(item.total) || 0).toFixed(2)),
  );
  const recoveredItems: NonNullable<ParsedDocument["lineItems"]> = [];
  const recoveredEvidence: NonNullable<ParsedDocument["planningSummaryRecovery"]>["recoveredEvidence"] = [];
  let ambiguousCandidateCount = 0;
  let runningTotal = initialLineItemsTotal;

  for (const rawCandidate of candidates as unknown[]) {
    if (
      typeof rawCandidate !== "object"
      || rawCandidate === null
      || Array.isArray(rawCandidate)
    ) {
      continue;
    }
    const candidate = rawCandidate as PlanningSummaryLineCandidate;
    const description = typeof candidate.description === "string"
      ? candidate.description.trim()
      : "";
    const totalHt = roundCurrency(Number(candidate.totalHt));
    const evidenceText = typeof candidate.evidenceText === "string"
      ? candidate.evidenceText.trim()
      : "";
    if (
      !description
      || !Number.isFinite(totalHt)
      || totalHt <= 0
      || candidate.includedInTotal !== true
      || typeof candidate.amountBasis !== "string"
      || candidate.amountBasis.trim().toUpperCase() !== "HT"
      || evidenceText.length < 3
    ) {
      continue;
    }

    const fingerprint = lineFingerprint(description, totalHt);
    if (fingerprints.has(fingerprint)) continue;
    const amountKey = totalHt.toFixed(2);
    if (usedAmounts.has(amountKey)) {
      ambiguousCandidateCount++;
      continue;
    }

    const remaining = roundCurrency(expectedHt - runningTotal);
    // Evidence-backed candidates still may not overshoot the known HT total.
    // Arithmetic is a safety check here, not a source for creating a line.
    if (totalHt > remaining) continue;

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
      ...(recovered.pageHint != null ? { pageHint: recovered.pageHint } : {}),
      ...(recovered.bbox != null ? { bbox: recovered.bbox } : {}),
    });
    fingerprints.add(fingerprint);
    usedAmounts.add(amountKey);
    runningTotal = roundCurrency(runningTotal + totalHt);
  }

  const finalLineItemsTotal = runningTotal;
  const reconciled = finalLineItemsTotal === expectedHt;
  const status = recoveryFailed
    ? "failed" as const
    : reconciled
      ? "reconciled" as const
      : recoveredItems.length > 0
        ? "partial" as const
        : "none" as const;
  const recoveredTotal = roundCurrency(finalLineItemsTotal - initialLineItemsTotal);
  const parsed: ParsedDocument = {
    ...input.parsed,
    lineItems: [...existingItems, ...recoveredItems],
    planningSummaryRecovery: {
      attempted: true,
      status,
      expectedHt,
      initialLineItemsTotal,
      difference,
      candidateCount: candidates.length,
      recoveredCount: recoveredItems.length,
      ambiguousCandidateCount,
      recoveredTotal,
      finalLineItemsTotal,
      recoveredEvidence,
      note: reconciled
        ? `Recovered ${recoveredItems.length} printed summary/totals-box option row(s) and reconciled the HT line total.`
        : "Summary/totals-box recovery did not fully reconcile the HT line total; human verification remains required.",
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