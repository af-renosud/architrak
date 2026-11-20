import type { ParsedDocument } from "../gmail/document-parser";
import type { DevisLineItem } from "@shared/schema";
import { loadQuotationDecisionSnapshot } from "./quotation-decision-snapshot";
import { evaluateQuotationDecision } from "./quotation-decision";
import { pricedEvidenceIssues, workingCoverageIssues } from "./quotation-source-evidence";

/** Compatibility adapters for callers which display one message. Decisions
 * remain authoritative; no independent legacy policy is maintained here. */
export async function quotationApprovalBlocker(devisId: number, options: { reviewing?: boolean } = {}): Promise<string | null> {
  const snapshot = await loadQuotationDecisionSnapshot(devisId);
  if (!snapshot) return "Quotation not found.";
  const decision = await evaluateQuotationDecision(snapshot, options.reviewing ? "approve" : "advance");
  return decision.issues.find(i => i.severity === "blocker")?.message ?? null;
}
export function pricedEvidenceBlocker(parsed: ParsedDocument, lines: DevisLineItem[]) {
  return pricedEvidenceIssues(parsed, lines)[0]?.message ?? null;
}
export function quotationWorkingCoverageBlocker(parsed: ParsedDocument | null, lines: DevisLineItem[]) {
  return workingCoverageIssues(parsed, lines)[0]?.message ?? null;
}
