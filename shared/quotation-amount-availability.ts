/** Zero is a valid amount. Only an explicitly provisional, failed extraction
 * whose stored zero is a placeholder should be labelled unavailable. */
export function quotationAmountsUnavailable(value: {
  manualIntakeReviewRequired?: boolean | null; aiExtractedData?: unknown;
  amountHt?: string | number | null; amountTtc?: string | number | null;
}) {
  const data = value.aiExtractedData as { amountHt?: unknown; amountTtc?: unknown } | null;
  return value.manualIntakeReviewRequired === true &&
    Number(value.amountHt) === 0 && Number(value.amountTtc) === 0 &&
    data?.amountHt == null && data?.amountTtc == null;
}
