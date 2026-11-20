import { createHash } from "node:crypto";
import { quotationIssue, type QuotationAction, type QuotationDecision, type QuotationIssue } from "@shared/quotation-decision";
import { quotationFinancialIssues } from "@shared/quotation-financial-decision";
import { getDocumentBuffer } from "../storage/object-storage";
import { pricedEvidenceIssues, workingCoverageIssues } from "./quotation-source-evidence";
import type { ParsedDocument } from "../gmail/document-parser";
import { quotationDecisionVersion, quotationPackageVersion, type QuotationDecisionSnapshot } from "./quotation-decision-snapshot";
import { quotationSigningIssues } from "@shared/quotation-signing-decision";
import { checkExtractionCompleteness } from "./extraction-completeness";
import { translationSnapshotIssues } from "./quotation-translation-coverage";

/** Authoritative source/review rules, independent of transport and UI.
 * Delivery-specific insurance, recipients and question authorisations remain
 * in their existing orchestration; this decision does not dispatch anything. */
export async function evaluateQuotationDecision(s: QuotationDecisionSnapshot, action: QuotationAction,
  readPdf = getDocumentBuffer, options: { verifySourceBytes?: boolean } = {}): Promise<QuotationDecision> {
  const { quotation: d, translation: t } = s;
  const issues: QuotationIssue[] = [];
  const add = (code: string, message: string, section: QuotationIssue["target"]["section"]) => issues.push(quotationIssue(code, message, section));
  if (s.archived) add("PROJECT_ARCHIVED", "Archived projects are read-only.", "lifecycle");
  if (d.accountingState === "superseded") add("QUOTATION_REPLACED", "This quotation has been replaced. Open its replacement.", "lifecycle");
  if (["void", "cancelled"].includes(d.status) || d.signOffStage === "void") add("QUOTATION_VOID", "This quotation has been cancelled.", "lifecycle");
  const version = quotationDecisionVersion(s);
  const result = () => ({ action, version, contentVersion: quotationPackageVersion(s), allowed: !issues.some(i => i.severity === "blocker"), issues });
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
      else if (options.verifySourceBytes !== false) {
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
    if (parsed && !humanReviewed) {
      for (const warning of checkExtractionCompleteness({ coverage: parsed.extractionCoverage,
        lineItems: s.lines.map(l => ({ description: l.description, pageHint: l.pdfPageHint })) }).filter(w => w.severity === "error")) {
        for (const page of warning.pages?.length ? warning.pages : [undefined]) {
          const issue = quotationIssue(warning.field === "pageCoverage" ? "PAGES_NOT_EXTRACTED" : "PAGE_ITEMS_MISSING",
            warning.message, "source", page ? `${warning.field}-page-${page}` : warning.field);
          if (page) issue.target.page = page;
          issues.push(issue);
        }
      }
    }
    if (parsed?.pricedItemVerification) {
      issues.push(...pricedEvidenceIssues(parsed, s.lines));
      if (parsed.nativeTableRecovery && (Math.round(Number(d.amountHt) * 100) !== Math.round(parsed.nativeTableRecovery.amountHt * 100)
        || Math.round(Number(d.amountTtc) * 100) !== Math.round(parsed.nativeTableRecovery.amountTtc * 100)))
        add("HEADER_TOTAL_MISMATCH", "Working header totals differ from the independently read original totals. Use Edit working quotation to reconcile the source.", "financial");
      if (options.verifySourceBytes !== false) try {
        if (!d.pdfStorageKey || createHash("sha256").update(await readPdf(d.pdfStorageKey)).digest("hex") !== parsed.pricedItemVerification.sourceDigest)
          add("SOURCE_DIGEST_MISMATCH", "The original PDF no longer matches its verification. Review the current source before approval.", "source");
      } catch { add("SOURCE_UNAVAILABLE", "The original PDF cannot be verified right now. Retry before approval.", "source"); }
    }
    if (!humanReviewed) {
      if (parsed && (parsed.documentType === "quotation" || Array.isArray(parsed.lineItems))
        && !parsed.pricedItemVerification && !parsed.illustratedRecovery && !parsed.quotationVerification)
        add("SOURCE_CONFIRMATION_REQUIRED", "This quotation has no source-verification receipt. Review the original PDF in Edit working quotation and confirm its source total before approval.", "source");
      else if (parsed?.illustratedRecovery || parsed?.quotationVerification) {
        // Priced evidence was already evaluated above.
        issues.push(...workingCoverageIssues({ ...parsed, pricedItemVerification: undefined }, s.lines));
      }
    }
  }
  if (action === "client_link") {
    if (d.accountingState === "provisional") add("ACCOUNTING_PROVISIONAL", "Resolve the provisional quotation before publishing it.", "lifecycle");
    if (t?.status !== "finalised") add("TRANSLATION_NOT_APPROVED", "Review and approve the translation before sharing it.", "translation");
  }
  if (action === "sign") {
    issues.push(...translationSnapshotIssues(s));
    for (const issue of quotationSigningIssues(d, t?.status ?? null, false))
      if (!issues.some(existing => existing.code === issue.code)) issues.push(issue);
  }
  if (options.verifySourceBytes === false && (s.baseline || (d.aiExtractedData as ParsedDocument | null)?.pricedItemVerification))
    issues.push({ ...quotationIssue("SOURCE_RECHECK_AT_COMMIT", "Original PDF bytes will be rechecked before approval or sending.", "source"), severity: "info" });
  return result();
}
