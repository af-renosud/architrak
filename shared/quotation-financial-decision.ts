import { correctionCents, correctionMoney, correctionFinancialIssues, previewCorrectionTotals, type ArchitectCorrectionDraft } from "./architect-quotation";
import { quotationIssue, type QuotationIssue } from "./quotation-decision";

/** Shared by preflight, atomic working saves and locked approval commit. */
export function quotationFinancialIssues(draft: ArchitectCorrectionDraft, baseline: { ttc: string } | null,
  workingTotals?: { ht: string; ttc: string }): QuotationIssue[] {
  const issues = correctionFinancialIssues(draft).map(i => quotationIssue(i.code, i.message, "financial", i.key, i.field, i.rowId));
  if (!baseline) issues.unshift(quotationIssue("SOURCE_CONFIRMATION_REQUIRED",
    "Confirm the original quotation total. Compare the VAT-inclusive total with the original PDF before checking the working figures against it.", "source"));
  if (issues.length) return issues;
  try {
    const totals = previewCorrectionTotals(draft);
    if (workingTotals && (correctionCents(totals.ht) !== correctionCents(workingTotals.ht) || correctionCents(totals.ttc) !== correctionCents(workingTotals.ttc)))
      return [quotationIssue("HEADER_TOTAL_MISMATCH", "Working header totals differ from the corrected row/VAT/discount calculation. Reconcile the financial batch before approval or sharing.", "financial", "header")];
    if (correctionCents(totals.ttc) !== correctionCents(baseline!.ttc))
      return [quotationIssue("SOURCE_TTC_MISMATCH", `The working figures don't match the original total: working total ${totals.ttc} EUR including VAT; confirmed original ${baseline!.ttc} EUR; difference ${correctionMoney(correctionCents(totals.ttc) - correctionCents(baseline!.ttc))} EUR. Review the amounts, VAT, discounts and included options. Confirming the original does not adjust the working figures.`, "financial", "header")];
    return [];
  } catch (error) {
    return [quotationIssue("FINANCIAL_BATCH_INVALID", `Complete the actual VAT/discount treatment before approval: ${error instanceof Error ? error.message : "Invalid figures."}`, "financial", "header")];
  }
}
