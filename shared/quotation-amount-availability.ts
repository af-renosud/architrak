/** Zero is valid when explicitly read. Missing extraction values must not
 * become apparent totals merely because the database needs numeric placeholders. */
export function quotationAmountsUnavailable(value: {
  manualIntakeReviewRequired?: boolean | null; aiExtractedData?: unknown;
  amountHt?: string | number | null; amountTtc?: string | number | null;
}) {
  const data = value.aiExtractedData as { amountHt?: unknown; amountTtc?: unknown } | null;
  if (!value.manualIntakeReviewRequired || (data?.amountHt != null && data?.amountTtc != null)) return false;
  // Manual intake stores the sole known amount in both columns (or zero in
  // both when neither is known). This placeholder is not an independently
  // known HT/TTC pair. Audited subsequent financial corrections leave the
  // immutable original extraction untouched.
  const placeholder = Number(data?.amountHt ?? data?.amountTtc ?? 0);
  return Number(value.amountHt) === placeholder && Number(value.amountTtc) === placeholder;
}
