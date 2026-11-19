import { createHash } from "node:crypto";
import { quotationIssue, type QuotationAction, type QuotationDecision, type QuotationIssue } from "@shared/quotation-decision";
import { quotationFinancialIssues } from "@shared/quotation-financial-decision";
import { getDocumentBuffer } from "../storage/object-storage";
import { quotationWorkingVersion } from "./quotation-working-version";
import { pricedEvidenceBlocker, quotationWorkingCoverageBlocker } from "./quotation-approval-guard";
import type { ParsedDocument } from "../gmail/document-parser";
import type { QuotationDecisionSnapshot } from "./quotation-decision-snapshot";

/** Authoritative source/review rules, independent of transport and UI.
 * Delivery-specific insurance, recipients and question authorisations remain
 * in their existing orchestration; this decision does not dispatch anything. */
export async function evaluateQuotationDecision(s: QuotationDecisionSnapshot, action: QuotationAction,
  readPdf = getDocumentBuffer): Promise<QuotationDecision> {
  const { quotation: d, translation: t } = s;
  const issues: QuotationIssue[] = [];
  const add = (code: string, message: string, section: QuotationIssue["target"]["section"]) => issues.push(quotationIssue(code, message, section));
  if (s.archived) add("PROJECT_ARCHIVED", "Archived projects are read-only.", "lifecycle");
  if (d.accountingState === "superseded") add("QUOTATION_REPLACED", "This quotation has been replaced. Open its replacement.", "lifecycle");
  if (["void", "cancelled"].includes(d.status) || d.signOffStage === "void") add("QUOTATION_VOID", "This quotation has been cancelled.", "lifecycle");
  const version = quotationWorkingVersion(d, s.lines, t);
  const result = () => ({ action, version, allowed: !issues.some(i => i.severity === "blocker"), issues });
  if (action === "save_content") return result(); // Financial incompleteness cannot veto wording.
  const reviewing = action === "approve";
  if (reviewing && (!t || !["draft", "edited", "finalised"].includes(t.status)))
    add("TRANSLATION_MISSING", "Prepare and save the English translation before approval.", "translation");
  const humanReviewed = t?.status === "finalised" && (t.headerTranslated as { humanReviewed?: boolean } | null)?.humanReviewed;
  if (s.baseline || action === "save_financial") {
    issues.push(...quotationFinancialIssues(s.draft, s.baseline, action === "save_financial" ? undefined : { ht: d.amountHt, ttc: d.amountTtc }));
    if (s.baseline) {
      if (s.baseline.storageKey !== d.pdfStorageKey)
        add("SOURCE_DIGEST_MISMATCH", "Original PDF no longer matches the confirmed source. Review the current source before approval.", "source");
      else {
        try {
          const digest = createHash("sha256").update(await readPdf(s.baseline.storageKey)).digest("hex");
          if (digest !== s.baseline.sourceDigest) add("SOURCE_DIGEST_MISMATCH", "Original PDF bytes no longer match the locked source receipt. Approval and sharing are blocked.", "source");
        } catch { add("SOURCE_UNAVAILABLE", "The original PDF receipt cannot currently be verified. Restore source access and retry; no content was approved.", "source"); }
      }
    }
    if (!reviewing && action !== "save_financial" && !(humanReviewed && t?.approvedAt))
      add("REVIEW_REQUIRED", "Review and approve the saved quotation in Review/edit quotation. The original TTC is already confirmed; no correction or repeat entry is needed.", "translation");
  } else {
    const parsed = d.aiExtractedData as ParsedDocument | null;
    if (parsed?.pricedItemVerification) {
      const blocker = pricedEvidenceBlocker(parsed, s.lines);
      if (blocker) add("PRICED_SOURCE_UNVERIFIED", blocker, "source");
      if (parsed.nativeTableRecovery && (Math.round(Number(d.amountHt) * 100) !== Math.round(parsed.nativeTableRecovery.amountHt * 100)
        || Math.round(Number(d.amountTtc) * 100) !== Math.round(parsed.nativeTableRecovery.amountTtc * 100)))
        add("HEADER_TOTAL_MISMATCH", "Working header totals differ from the independently read original totals. Use Edit working quotation to reconcile the source.", "financial");
      try {
        if (!d.pdfStorageKey || createHash("sha256").update(await readPdf(d.pdfStorageKey)).digest("hex") !== parsed.pricedItemVerification.sourceDigest)
          add("SOURCE_DIGEST_MISMATCH", "The original PDF no longer matches its verification. Review the current source before approval.", "source");
      } catch { add("SOURCE_UNAVAILABLE", "The original PDF cannot be verified right now. Retry before approval.", "source"); }
    }
    if (!humanReviewed) {
      if (parsed && (parsed.documentType === "quotation" || Array.isArray(parsed.lineItems))
        && !parsed.pricedItemVerification && !parsed.illustratedRecovery && !parsed.quotationVerification)
        add("SOURCE_CONFIRMATION_REQUIRED", "This quotation has no source-verification receipt. Review the original PDF in Edit working quotation and confirm its source total before approval.", "source");
      else if (parsed?.illustratedRecovery || parsed?.quotationVerification) {
        const blocker = quotationWorkingCoverageBlocker(parsed, s.lines);
        if (blocker) add("COVERAGE_INCOMPLETE", blocker, "source");
      }
    }
  }
  if (action === "client_link") {
    if (d.accountingState === "provisional") add("ACCOUNTING_PROVISIONAL", "Resolve the provisional quotation before publishing it.", "lifecycle");
    if (t?.status !== "finalised") add("TRANSLATION_NOT_APPROVED", "Review and approve the translation before sharing it.", "translation");
  }
  return result();
}
