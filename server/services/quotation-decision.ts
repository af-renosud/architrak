import { createHash } from "node:crypto";
import { quotationIssue, quotationLifecycleIssues, type QuotationAction, type QuotationDecision, type QuotationIssue } from "@shared/quotation-decision";
import { quotationFinancialIssues } from "@shared/quotation-financial-decision";
import { getDocumentBuffer } from "../storage/object-storage";
import { pricedEvidenceIssues, printedVatIssues, workingCoverageIssues } from "./quotation-source-evidence";
import type { ParsedDocument } from "../gmail/document-parser";
import { quotationDecisionVersion, quotationPackageVersion, type QuotationDecisionSnapshot } from "./quotation-decision-snapshot";
import { quotationSigningIssues } from "@shared/quotation-signing-decision";
import { checkExtractionCompleteness } from "./extraction-completeness";
import { translationSnapshotIssues } from "./quotation-translation-coverage";
import { quotationAmountsUnavailable } from "@shared/quotation-amount-availability";
import { sourceRowsForCarriedWording } from "./quotation-carried-wording";

/** Authoritative source/review rules, independent of transport and UI.
 * Delivery-specific insurance, recipients and question authorisations remain
 * in their existing orchestration; this decision does not dispatch anything. */
export async function evaluateQuotationDecision(s: QuotationDecisionSnapshot, action: QuotationAction,
  readPdf = getDocumentBuffer, options: { verifySourceBytes?: boolean } = {}): Promise<QuotationDecision> {
  const { quotation: d, translation: t } = s;
  const sourceLines = sourceRowsForCarriedWording(d, s.lines, s.carryForwardAudits);
  const issues: QuotationIssue[] = quotationLifecycleIssues(d, action, s.archived);
  const add = (code: string, message: string, section: QuotationIssue["target"]["section"]) => issues.push(quotationIssue(code, message, section));
  const version = quotationDecisionVersion(s);
  const result = () => ({ action, version, contentVersion: quotationPackageVersion(s), allowed: !issues.some(i => i.severity === "blocker"), issues });
  if (action === "save_content") return result(); // Financial incompleteness cannot veto wording.
  if (["register", "indicative_budget"].includes(action)) {
    return result(); // Budget disclosure has its own explicit, source-linked snapshot confirmation.
  }
  if (action === "prepare_translation") {
    const header = d.descriptionFr?.trim().toLowerCase();
    const filenameOnly = d.manualIntakeReviewRequired && !s.hasCorrection &&
      [d.pdfFileName, d.devisCode].some(value => value?.trim().toLowerCase() === header);
    if (!s.lines.some(line => line.description?.trim()) && (!header || filenameOnly))
      add("WORDING_MISSING", "Add the French description in Edit working quotation, then prepare its English wording. Figures can be completed later.", "translation");
    return result();
  }
  const extractionTotals = d.aiExtractedData as { amountHt?: unknown; amountTtc?: unknown } | null;
  if (!s.baseline && (quotationAmountsUnavailable(d) || d.manualIntakeReviewRequired &&
      (extractionTotals?.amountHt == null || extractionTotals?.amountTtc == null)))
    add("FIGURES_UNAVAILABLE", "The quotation totals could not be read. You can still edit wording and context or review an indicative budget. Before approval or signing, compare and confirm the figures in Edit working quotation.", "source");
  const reviewing = action === "approve";
  if (reviewing && (!t || !["draft", "edited", "finalised"].includes(t.status)))
    add("TRANSLATION_MISSING", "Prepare and save the English translation before approval.", "translation");
  if (reviewing && t) {
    const translatedLines = Array.isArray(t.lineTranslations) ? t.lineTranslations : [];
    const header = t.headerTranslated as { description?: string } | null;
    if ((d.descriptionFr?.trim() && !header?.description?.trim()) ||
        s.lines.some(line => line.description.trim() && !translatedLines.some((target: any) =>
          target.lineNumber === line.lineNumber && typeof target.translation === "string" && target.translation.trim())) ||
        (!header?.description?.trim() && !translatedLines.some((target: any) => target.translation?.trim())))
      add("TRANSLATION_INCOMPLETE", "Some English wording is missing. Fill the empty English fields in Edit working quotation, then save before approval.", "translation");
  }
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
      issues.push(...pricedEvidenceIssues(parsed, sourceLines));
      issues.push(...printedVatIssues(parsed, s.lines, s.draft));
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
        && !parsed.pricedItemVerification && !parsed.illustratedRecovery && !parsed.quotationVerification) {
        add("SOURCE_CONFIRMATION_REQUIRED", "Confirm the original quotation total. A check against the original PDF has not been recorded; this does not mean the amount is wrong. Compare the VAT-inclusive total with the PDF and confirm whether it matches.", "source");
      }
      else if (parsed?.illustratedRecovery || parsed?.quotationVerification) {
        // Priced evidence was already evaluated above.
        issues.push(...workingCoverageIssues({ ...parsed, pricedItemVerification: undefined }, sourceLines));
      }
    }
  }
  // Any route into human source confirmation should reveal known financial gaps
  // before that confirmation, not spring a second checklist on the operator.
  if (!s.baseline && issues.some(issue => ["FIGURES_UNAVAILABLE", "SOURCE_CONFIRMATION_REQUIRED", "DESCRIPTION_CHARGE_UNVERIFIED",
    "COVERAGE_INCOMPLETE", "SOURCE_RECEIPT_OUTDATED", "SOURCE_ROWS_CHANGED", "SOURCE_INVENTORY_CHANGED",
    "PAGES_NOT_EXTRACTED", "PAGE_ITEMS_MISSING"].includes(issue.code))) {
    issues.push(...quotationFinancialIssues(s.draft, null).filter(issue => issue.code !== "SOURCE_CONFIRMATION_REQUIRED"
      && !issues.some(existing => existing.code === issue.code && existing.key === issue.key)));
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
