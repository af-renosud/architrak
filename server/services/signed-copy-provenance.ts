import { createHash } from "node:crypto";
import type { Devis } from "@shared/schema";

/** Manual attestation is not Archisign verification. Never invent an envelope. */
export function manualSignedCopyAttestation(d: Devis): string | null {
  if (d.signOffStage !== "client_signed_off" || d.signedOffVia !== "manual_upload" ||
      !d.signedPdfStorageKey || d.signedPdfArchisignEnvelopeId != null ||
      !d.manualSignoffBy?.trim() || !d.manualSignoffNote || d.manualSignoffNote.trim().length < 10 ||
      !d.manualSignoffAt || !Number.isFinite(new Date(d.manualSignoffAt).getTime())) return null;
  return createHash("sha256").update(JSON.stringify({
    at: new Date(d.manualSignoffAt).toISOString(), by: d.manualSignoffBy,
    note: d.manualSignoffNote, reference: d.manualSignoffExternalRef ?? null,
  })).digest("hex");
}

export function signedCopyEnvelope(d: Devis): string | null {
  return d.signedOffVia === "manual_upload" ? null : d.archisignEnvelopeId;
}

export function signedCopyInactive(d: Devis): boolean {
  return ["void", "cancelled", "superseded"].includes(d.status) ||
    d.signOffStage === "void" || d.accountingState === "superseded";
}

export function signedCopyContentHash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
