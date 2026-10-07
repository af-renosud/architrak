export function canBulkVoidDevis(doc: {
  status: string; signOffStage?: string | null; dateSigned?: string | null; archisignEnvelopeId?: string | null; accountingState?: string | null;
  archisignPinnedPdfStorageKey?: string | null; signedPdfStorageKey?: string | null;
}, archived: boolean) {
  return !archived && doc.status === "draft" && !doc.dateSigned && !doc.archisignEnvelopeId
    && !doc.archisignPinnedPdfStorageKey && !doc.signedPdfStorageKey
    && !["sent_to_client", "client_signed_off", "void"].includes(doc.signOffStage ?? "")
    && doc.accountingState !== "superseded";
}

export function canBulkDeleteIntake(doc: {
  promotedId?: number | null; analysisState: string; routingState: string; extractedData?: unknown;
}, archived: boolean) {
  const extracted = doc.extractedData as { projectIdentityResolution?: unknown; openingAcompteResolution?: unknown } | null;
  return !archived && doc.promotedId == null && ["analyzed", "failed"].includes(doc.analysisState)
    && ["routed", "duplicate", "parked", "failed"].includes(doc.routingState)
    && !extracted?.projectIdentityResolution && !extracted?.openingAcompteResolution;
}

export function canBulkDiscardInvoice(doc: { id: number; status: string; datePaid?: string | null }, archived: boolean, certified: boolean, deposit: boolean) {
  return !archived && doc.status === "draft" && !doc.datePaid && !certified && !deposit;
}

export function canBulkDeletePlanning(revision: { status: string; promotedDevisId?: number | null; promotedAt?: string | null }, archived: boolean, importing: boolean) {
  return !archived && revision.status === "draft" && !revision.promotedDevisId && !revision.promotedAt && !importing;
}
