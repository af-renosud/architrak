import type { Devis, SignedDevisCopyNotice, ProjectCommunication } from "@shared/schema";
import { manualSignedCopyAttestation, signedCopyEnvelope } from "./signed-copy-provenance";

/** Only evidence for this exact stored signed document counts on the card. */
export function matchesCurrentSignedCopy(
  d: Devis, notice: SignedDevisCopyNotice, communication?: ProjectCommunication,
): boolean {
  if (!d.signedPdfStorageKey || notice.devisId !== d.id ||
      notice.projectId !== d.projectId || notice.intendedContractorId !== d.contractorId ||
      notice.archisignEnvelopeId !== signedCopyEnvelope(d)) return false;
  const snapshot = notice.confirmationSnapshot as { manualAttestationHash?: string } | null;
  if (d.signedOffVia === "manual_upload" &&
      (!manualSignedCopyAttestation(d) || snapshot?.manualAttestationHash !== manualSignedCopyAttestation(d))) return false;
  // Before an automatic notice has an attachment, it is pending, never sent.
  if (!communication) return notice.status === "pending_pdf";
  const attachments = communication.attachmentStorageKeys;
  return Array.isArray(attachments) && attachments.length === 1 && attachments[0] === d.signedPdfStorageKey;
}
