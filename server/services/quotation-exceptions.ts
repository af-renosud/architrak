import type { QuotationExceptionReview } from "@shared/quotation-exceptions";
import { quotationIssue, type QuotationIssue } from "@shared/quotation-decision";
import type { QuotationDecisionSnapshot } from "./quotation-decision-snapshot";
import { evaluateQuotationDecision } from "./quotation-decision";
import type { ParsedDocument } from "../gmail/document-parser";
import { validateExtraction } from "./extraction-validator";

/** Current actionable findings, separate from the immutable historical verdict.
 * This read-only projection never grants approval or changes machine evidence. */
export async function quotationExceptionReview(s: QuotationDecisionSnapshot): Promise<QuotationExceptionReview> {
  const decision = await evaluateQuotationDecision(s, "approve", undefined, { verifySourceBytes: false });
  const parsed = s.quotation.aiExtractedData as ParsedDocument | null;
  const current = decision.issues.filter(i => ["source", "financial"].includes(i.target.section) && i.severity !== "info");
  const human = Boolean(s.baseline && s.translation?.approvedAt && s.translation.status === "finalised"
    && (s.translation.headerTranslated as { humanReviewed?: boolean } | null)?.humanReviewed
    && current.length === 0);
  const groups: QuotationExceptionReview["groups"] = [
    { id: "source", label: "Check against the original", issues: current.filter(i => i.target.section === "source") },
    { id: "figures", label: "Figures to reconcile", issues: current.filter(i => i.target.section === "financial") },
    { id: "completeness", label: "Extraction details to review", issues: [] },
  ];
  const add = (issue: QuotationIssue) => {
    if (!groups.some(g => g.issues.some(i => i.code === issue.code && i.key === issue.key)))
      groups[2].issues.push(issue);
  };
  // A current human-controlled draft is checked by the financial evaluator,
  // never against obsolete machine rows or an old source-coverage verdict.
  if (parsed && !s.baseline) {
    const validation = validateExtraction({ ...parsed, amountHt: Number(s.quotation.amountHt), amountTtc: Number(s.quotation.amountTtc),
      lineItems: s.lines.map(l => ({ description: l.description, total: Number(l.totalHt),
        unitPrice: l.unitPriceHt == null ? undefined : Number(l.unitPriceHt), pageHint: l.pdfPageHint ?? undefined })) });
    const mapped: Record<string, string> = { pageCoverage: "PAGES_NOT_EXTRACTED", pageLineItems: "PAGE_ITEMS_MISSING",
      lineNumbering: "ITEM_NUMBERING_GAP", lineFragment: "POSSIBLE_CONTINUATION",
      lineItems: "SOURCE_TOTAL_DISCREPANCY", tvaAmount: "SOURCE_TAX_DISCREPANCY", derivedTotals: "TOTALS_DERIVED_NOT_VERIFIED" };
    for (const warning of validation.warnings) {
      if (!mapped[warning.field]) continue;
      if (warning.pages?.length) {
        for (const page of warning.pages) {
          const issue = quotationIssue(mapped[warning.field], warning.message, "source", `${warning.field}-page-${page}`);
          issue.severity = warning.severity === "error" ? "blocker" : "warning";
          issue.target.page = page;
          add(issue);
        }
        continue;
      }
      for (const number of warning.lines?.length ? warning.lines : [undefined]) {
        const line = s.lines.find(l => l.lineNumber === number);
        const issue = quotationIssue(mapped[warning.field], warning.message, warning.field === "lineItems" || warning.field === "tvaAmount" ? "financial" : "source",
          line ? `line-${line.id}` : warning.field, line ? "descriptionFr" : undefined, line?.id);
        issue.severity = warning.severity === "error" ? "blocker" : "warning";
        if (line?.pdfPageHint) issue.target.page = line.pdfPageHint;
        if (!issue.target.page && warning.pages?.length === 1) issue.target.page = warning.pages[0];
        add(issue);
      }
    }
    for (const evidence of parsed.quotationVerification?.coverage?.issues ?? []) {
      const issue = quotationIssue(`SOURCE_${evidence.kind.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`,
        `Source content needs review on page ${evidence.page}, section ${evidence.section}.`, "source", evidence.segmentId);
      issue.target.page = evidence.page;
      add(issue);
    }
  }
  return { version: decision.version, groups: groups.filter(g => g.issues.length),
    historicalWarningCount: Array.isArray(s.quotation.validationWarnings) ? s.quotation.validationWarnings.length : 0,
    resolvedByHumanReview: human,
    sourceIdentity: { parser: parsed?.pricedItemVerification?.parser ?? parsed?.nativeTableRecovery?.parser ?? null,
      sourceDigest: parsed?.pricedItemVerification?.sourceDigest ?? parsed?.quotationVerification?.sourceDigest ?? null } };
}
