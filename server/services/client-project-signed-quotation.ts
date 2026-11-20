import type { Devis } from "@shared/schema";
import { quotationCommitmentStatus } from "@shared/quotation-commitment";
import { manualSignedCopyAttestation } from "./signed-copy-provenance";

/** Automatic visibility grants the signed record, not access to later working edits. */
export function isAutomaticSignedQuotation(d: Devis): boolean {
  return d.signOffStage !== "void" && quotationCommitmentStatus(d) === "signed";
}

export function clientSignedPdfKey(d: Devis): string | null {
  if (!isAutomaticSignedQuotation(d) || !d.signedPdfStorageKey) return null;
  if (d.signedOffVia === "manual_upload")
    return manualSignedCopyAttestation(d) ? d.signedPdfStorageKey : null;
  return d.archisignEnvelopeId && d.signedPdfArchisignEnvelopeId === d.archisignEnvelopeId
    ? d.signedPdfStorageKey : null;
}
