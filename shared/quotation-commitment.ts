/** Reporting classification, not a legal opinion. Generic workflow/accounting
 * activation and approval to sign are deliberately not signature evidence. */
export interface QuotationCommitmentEvidence {
  status?: string | null;
  accountingState?: string | null;
  signOffStage?: string | null;
  archisignEnvelopeStatus?: string | null;
  signedOffVia?: string | null;
  manualSignoffAt?: unknown;
  signedPdfStorageKey?: string | null;
}

export function quotationCommitmentStatus(d: QuotationCommitmentEvidence): "signed" | "unsigned" | "inactive" {
  if (d.accountingState !== "active" || ["void", "cancelled", "superseded"].includes(d.status ?? "")) return "inactive";
  // client_signed_off predates provenance columns and remains authoritative
  // for legacy signatures. Durable signed-PDF evidence survives stage rollback.
  const signed = d.signOffStage === "client_signed_off"
    || d.archisignEnvelopeStatus === "signed"
    || Boolean(d.signedPdfStorageKey)
    || (d.signedOffVia === "manual_upload" && Boolean(d.manualSignoffAt))
    || d.status === "signed";
  return signed ? "signed" : "unsigned";
}
