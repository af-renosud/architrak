export interface ClientBudgetEntry {
  devisId: number;
  title: string;
  reference: string;
  contractor: string;
  amountHt: string;
  amountTtc: string;
  basis?: "reviewed_source_total";
  /** Internal provenance, stripped from public responses. */
  sourceReview?: { digest: string; page: number; sourceKeyHash: string };
}
export interface ClientBudgetCandidate {
  devisId: number;
  /** Architect-facing internal code (e.g. MXT.3.MIXED WORKS RENOVATION). Never part of a shared entry. */
  internalCode?: string | null;
  current: ClientBudgetEntry | null;
  shared: ClientBudgetEntry | null;
  changed: boolean;
  signed: boolean;
  excluded: boolean;
  blockedReason: string | null;
  canReviewIndicative?: boolean;
  figuresUnavailable?: boolean;
  sourcePdfUrl?: string;
}
export interface ClientBudgetState {
  version: string;
  candidates: ClientBudgetCandidate[];
  signedHt: number;
  signedTtc: number;
  readOnly: boolean;
}
export interface ClientBudgetSave {
  version: string;
  entries: { devisId: number; title: string; refresh: boolean; reviewedTotals?: {
    amountHt: string; amountTtc: string; pdfPage: number; confirmedFromPdf: true;
  } }[];
  alternativesReviewed: true;
}
export interface PublicClientBudget {
  entries: (ClientBudgetEntry & { status: "signed" | "under_consideration" })[];
  unsignedHt: number;
  unsignedTtc: number;
}
