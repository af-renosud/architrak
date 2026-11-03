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

/** Keep signature frames on the outer card in both disclosure states. */
export function devisCardClassName(devis: QuotationCommitmentEvidence, expanded: boolean): string {
  const commitment = quotationCommitmentStatus(devis);
  // A stale sent stage/envelope must not highlight a terminal workflow.
  const terminalStates = ["void", "superseded", "client_rejected", "rejected", "declined", "cancelled", "canceled", "expired"];
  const terminal = [devis.status, devis.signOffStage, devis.archisignEnvelopeStatus]
    .some(state => terminalStates.includes(state ?? ""));
  const awaitingSignature = commitment === "unsigned" && !terminal && (
    devis.signOffStage === "sent_to_client"
    || ["sent", "viewed", "queried"].includes(devis.archisignEnvelopeStatus ?? "")
  );
  return [
    commitment === "signed"
      ? "border-[3px] border-green-600 dark:border-green-600"
      : awaitingSignature
        ? "border-[3px] border-orange-600 dark:border-orange-600"
        : expanded
          ? "border-2 border-[#0B2545]/40 dark:border-[#0B2545]/60"
          : "",
    expanded ? "shadow-[0_2px_8px_rgba(11,37,69,0.08)]" : "",
    "transition-[border-color,box-shadow] duration-150",
  ].filter(Boolean).join(" ");
}
