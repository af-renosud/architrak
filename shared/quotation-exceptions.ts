import type { QuotationIssue } from "./quotation-decision";
export interface QuotationExceptionReview {
  version: string;
  groups: Array<{ id: "source" | "figures" | "completeness"; label: string; issues: QuotationIssue[] }>;
  historicalWarningCount: number;
  resolvedByHumanReview: boolean;
  sourceIdentity: { parser: string | null; sourceDigest: string | null };
}
