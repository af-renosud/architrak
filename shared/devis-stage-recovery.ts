export const REVIEW_STAGES = ["received", "checked_internal", "approved_for_signing", "sent_to_client", "client_signed_off"] as const;
type SignatureEvidence = {
  status?: string | null; accountingState?: string | null; signOffStage?: string | null;
  signedPdfStorageKey?: string | null; signedOffVia?: string | null;
  manualSignoffAt?: unknown; archisignEnvelopeStatus?: string | null;
};
export function hasRecordedSignature(d: SignatureEvidence): boolean {
  if (["void", "cancelled", "superseded"].includes(d.status ?? "") || d.signOffStage === "void" ||
    d.accountingState === "superseded") return false;
  return d.signOffStage === "client_signed_off" || d.archisignEnvelopeStatus === "signed" ||
    !!d.signedPdfStorageKey || (d.signedOffVia === "manual_upload" && !!d.manualSignoffAt);
}
export function canRestoreSignedStage(d: SignatureEvidence): boolean {
  return hasRecordedSignature(d) && !!d.signedPdfStorageKey &&
    (d.signedOffVia === "manual_upload" && !!d.manualSignoffAt || d.archisignEnvelopeStatus === "signed") &&
    REVIEW_STAGES.slice(0, 4).includes(d.signOffStage as any);
}
export function requiresStageReopenConfirmation(from: string, to: string): boolean {
  const previous = REVIEW_STAGES.indexOf(from as any), next = REVIEW_STAGES.indexOf(to as any);
  return previous >= 2 && next >= 0 && next < previous;
}
