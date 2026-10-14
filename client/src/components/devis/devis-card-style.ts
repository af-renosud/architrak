import { quotationCommitmentStatus, type QuotationCommitmentEvidence } from "@shared/quotation-commitment";

/** Stable partition without sorting or mutating the query-cache array. */
export function signedDevisFirst<T extends QuotationCommitmentEvidence>(devis: readonly T[]): T[] {
  const signed: T[] = [];
  const remaining: T[] = [];
  for (const item of devis) {
    (quotationCommitmentStatus(item) === "signed" ? signed : remaining).push(item);
  }
  return [...signed, ...remaining];
}

/** Keep the signed frame on the outer card in both disclosure states. */
export function devisCardClassName(devis: QuotationCommitmentEvidence, expanded: boolean): string {
  const signed = quotationCommitmentStatus(devis) === "signed";
  return [
    signed
      ? "border-[3px] border-green-600 dark:border-green-600"
      : expanded
        ? "border-2 border-[#0B2545]/40 dark:border-[#0B2545]/60"
        : "",
    expanded ? "shadow-[0_2px_8px_rgba(11,37,69,0.08)]" : "",
    "transition-[border-color,box-shadow] duration-150",
  ].filter(Boolean).join(" ");
}
