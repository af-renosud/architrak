/** Durable evidence remains authoritative even if a workflow stage is rolled back. */
export function hasSignedOrClosedEvidence(row: Record<string, any>): boolean {
  const fields = ["signedPdfStorageKey", "signedPdfFetchUrlSnapshot", "signedPdfArchisignEnvelopeId",
    "archisignPinnedPdfStorageKey", "identityVerification", "signedOffVia", "manualSignoffAt",
    "manualSignoffBy", "manualSignoffNote", "manualSignoffExternalRef", "closedAt", "closureMarcheId"];
  return fields.some(key => Boolean(row[key] ?? row[key.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`)]))
    || (row.closureState ?? row.closure_state ?? "open") !== "open"
    || (row.archisignEnvelopeStatus ?? row.archisign_envelope_status) === "signed";
}

export function missingSourceTotalChanges(current: Record<string, any>, updates: Record<string, unknown>): string[] {
  if (!current.pdfStorageKey) return [];
  const raw = current.aiExtractedData ?? {};
  const changed = ["amountHt", "amountTtc"].filter(key => updates[key] != null && Number(updates[key]) !== Number(current[key]));
  for (const key of changed) {
    const missingZero = Number(current[key]) === 0 && raw[key] == null;
    const otherKey = key === "amountHt" ? "amountTtc" : "amountHt";
    const missingCopiedDefault = raw[key] == null && raw[otherKey] != null &&
      Number(current[key]) === Number(raw[otherKey]);
    if ((!missingZero && !missingCopiedDefault) || hasSignedOrClosedEvidence(current))
      throw new Error("Recorded contractor figures cannot be amended. Only missing extraction totals may be transcribed from the original PDF.");
  }
  return changed;
}