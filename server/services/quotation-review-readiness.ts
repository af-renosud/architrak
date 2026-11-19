import { storage } from "../storage";
import { architectCorrectionService, hasQuotationSourceBaseline, architectFinancialBoundary } from "./architect-quotation-correction";
import { quotationApprovalBlocker } from "./quotation-approval-guard";
import { quotationWorkingVersion } from "./quotation-working-version";
import { correctionFinancialIssues } from "../../shared/architect-quotation";

/** Read-only preflight. Approval rechecks safeguards and commits the exact version. */
export async function quotationReviewReadiness(devisId: number) {
  const [quotation, lines, translation] = await Promise.all([
    storage.getDevis(devisId), storage.getDevisLineItems(devisId), storage.getDevisTranslation(devisId),
  ]);
  if (!quotation) return null;
  const blockers: Array<{ key: string; message: string }> = [];
  if (!translation || !["draft", "edited", "finalised"].includes(translation.status))
    blockers.push({ key: "translation", message: "Prepare and save the English translation before approval." });
  if (await hasQuotationSourceBaseline(devisId)) {
    const snapshot = await architectCorrectionService.get(devisId);
    if (snapshot.blockedReason) blockers.push({ key: "source", message: snapshot.blockedReason });
    if (!snapshot.baseline) blockers.push({ key: "source", message: "Confirm the final TTC and page from the original PDF." });
    blockers.push(...correctionFinancialIssues(snapshot.draft));
    // Includes source-byte verification, exact totals and header reconciliation.
    const financial = await architectFinancialBoundary(devisId);
    if (financial && !blockers.some(issue => financial.includes(issue.message))
      && !(financial.startsWith("Confirm the source TTC") && !snapshot.baseline))
      blockers.push({ key: financial.includes("PDF") ? "source" : "header", message: financial });
  } else {
    const source = await quotationApprovalBlocker(devisId, { reviewing: true });
    if (source) blockers.push({ key: "source", message: source });
  }
  return { version: quotationWorkingVersion(quotation, lines, translation), status: translation?.status ?? "missing", blockers };
}
