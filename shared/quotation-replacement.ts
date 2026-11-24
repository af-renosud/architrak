export interface ReplacementQuotation {
  id: number;
  devisCode: string;
  devisNumber: string | null;
  descriptionFr: string;
  contractorId: number;
  contractorName: string;
  amountHt: string;
  amountTtc: string;
  signed: boolean;
  version: string;
  blockedReason: string | null;
}
export interface ReplacementImpact {
  invoices: number;
  situations: number;
  marcheDocuments: number;
  certificates: number;
  payments: number;
}
export interface ReplacementOptions {
  source: ReplacementQuotation;
  candidates: ReplacementQuotation[];
  impact: ReplacementImpact;
  impactVersion: string;
  blockedReason: string | null;
}
export interface QuotationReplacementHistory {
  id: number;
  oldDevisId: number;
  newDevisId: number;
  oldLabel: string;
  newLabel: string;
  note: string;
  actorName: string;
  createdAt: string;
}
export interface ReplaceQuotationRequest {
  preparedExtraction?: {
    attemptId: number;
    reason: string;
    reviewedOriginal: true;
    initialDifferencesAreOcrErrors: true;
  };
  carryForward?: import("./quotation-carry-forward").CarryForwardSelection;
  replacementDevisId: number;
  note: string;
  sourceVersion: string;
  targetVersion: string;
  impactVersion: string;
  differentContractorAcknowledged: boolean;
}
