export type CommitmentStatus = "signed" | "unsigned" | "inactive";

export interface CommitmentSummary {
  commitmentEligible: boolean;
  commitmentStatus: CommitmentStatus;
}

export interface DevisFinancialSummary extends CommitmentSummary {
  hasFinancialEvidence: boolean;
  devisId: number;
  devisCode: string;
  descriptionFr: string;
  descriptionUk: string | null;
  status: string;
  contractorId: number;
  invoicingMode: string;
  originalHt: number;
  originalTtc: number;
  pvTotal: number;
  mvTotal: number;
  adjustedHt: number;
  adjustedTtc: number;
  certifiedHt: number;
  certifiedTtc: number;
  acompteCertifiedHt?: number;
  acompteCertifiedTtc?: number;
  acompteAppliedHt?: number;
  acompteAppliedTtc?: number;
  currentInvoiceBalanceTtc?: number | null;
  acomptePaymentConflict?: boolean;
  resteARealiser: number;
  resteARealiserTtc: number;
  invoiceCount: number;
  avenantCount: number;
}

export interface FinancialSummary {
  projectId: number;
  projectName: string;
  projectCode: string;
  totalContractedHt: number;
  totalContractedTtc: number;
  totalCertifiedHt: number;
  totalCertifiedTtc: number;
  totalResteARealiser: number;
  totalResteARealiserTtc: number;
  totalOriginalHt: number;
  totalOriginalTtc: number;
  totalPv: number;
  totalMv: number;
  totalPendingHt: number;
  totalPendingTtc: number;
  totalExcludedCertifiedHt: number;
  totalExcludedCertifiedTtc: number;
  financialExceptions: DevisFinancialSummary[];
  devis: DevisFinancialSummary[];
}

export function commitmentLabel(row: Partial<CommitmentSummary>): string {
  if (row.commitmentStatus === "inactive") return "Inactive — excluded from commitment";
  if (row.commitmentStatus === "unsigned") return "Not signed — excluded from commitment";
  if (row.commitmentStatus === "signed" && row.commitmentEligible) return "Signed commitment";
  return "Commitment status unavailable";
}

export function isSignedCommitment(row: Partial<CommitmentSummary>): boolean {
  return row.commitmentStatus === "signed" && row.commitmentEligible === true;
}
