import { loadQuotationDecisionSnapshot } from "./quotation-decision-snapshot";
import { evaluateQuotationDecision } from "./quotation-decision";

/** Coherent read-only preflight; commit evaluates the same rules under locks. */
export async function quotationReviewReadiness(devisId: number) {
  const snapshot = await loadQuotationDecisionSnapshot(devisId);
  if (!snapshot) return null;
  const decision = await evaluateQuotationDecision(snapshot, "approve");
  return { ...decision, status: snapshot.translation?.status ?? "missing",
    blockers: decision.issues.filter(issue => issue.severity === "blocker") };
}
