import type { ParsedDocument } from "../gmail/document-parser";
import { CODED_LOT_TABLE_PARSER } from "./quotation-coded-lot-table";
import type { DevisLineItem } from "@shared/schema";
import { quotationIssue, type QuotationIssue } from "@shared/quotation-decision";
import { correctionCents, correctionMoney, previewCorrectionTotals, type ArchitectCorrectionDraft } from "@shared/architect-quotation";
import { verifyQuotationManifest } from "./quotation-source-manifest";
import { PRICED_EVIDENCE_PARSER, pricedRowsDigest } from "./quotation-priced-evidence";

export function pricedEvidenceIssues(parsed: ParsedDocument, lines: DevisLineItem[]): QuotationIssue[] {
  const evidence = parsed.pricedItemVerification;
  if (!evidence) return [];
  if (evidence.parser !== PRICED_EVIDENCE_PARSER) return [quotationIssue("SOURCE_RECEIPT_OUTDATED", "Source verification is out of date. Review the original in Edit working quotation.", "source")];
  // A layout no reader supports flags every row identically: one clear step,
  // not one blocker per item.
  if (evidence.issues.length >= 2 && evidence.issues.length === lines.length && !parsed.nativeTableRecovery) {
    const pages = evidence.issues.map(item => item.page).filter((p): p is number => !!p);
    const issue = quotationIssue("DESCRIPTION_CHARGE_UNVERIFIED",
      `This supplier's PDF layout could not be checked automatically (${lines.length} items). In Review/edit quotation, compare the VAT-inclusive total with the original PDF${pages.length ? ` (pages ${Math.min(...pages)}–${Math.max(...pages)} and the totals page)` : ""}, confirm it, and check each item's VAT rate.`,
      "source", "source");
    if (pages.length) issue.target.page = Math.min(...pages);
    return [issue];
  }
  const coded = parsed.nativeTableRecovery?.parser === CODED_LOT_TABLE_PARSER;
  if (evidence.issues.length) return evidence.issues.map(item => {
    const row = lines.find(l => l.lineNumber === item.line);
    const issue = quotationIssue("DESCRIPTION_CHARGE_UNVERIFIED",
      `Source review required: item ${item.line}${item.page ? ` (PDF page ${item.page})` : ""}. ${coded ? `${item.reason} Correct it in Review/edit quotation, or confirm the original total.` : "Review the original source and confirm its total."}`,
      "source", row ? `line-${row.id}` : "source", "descriptionFr", row?.id);
    if (item.page) issue.target.page = item.page;
    return issue;
  });
  const current = [...lines].sort((a, b) => a.lineNumber - b.lineNumber).map(line => ({
    description: line.description, total: Number(line.totalHt),
  }));
  if (pricedRowsDigest(current) !== evidence.rowsDigest) return [quotationIssue("SOURCE_ROWS_CHANGED",
    "Working rows changed since source verification. Review and save them in Edit working quotation before approval.", "source")];
  if (!parsed.nativeTableRecovery || current.reduce((total, line) => total + Math.round(line.total * 100), 0) !== Math.round(parsed.nativeTableRecovery.amountHt * 100))
    return [quotationIssue("SOURCE_ITEM_SUM_MISMATCH", "The working item sum does not reconcile with the independently read original total.", "financial", "header")];
  return [];
}

export function workingCoverageIssues(parsed: ParsedDocument | null, lines: DevisLineItem[]): QuotationIssue[] {
  if (parsed?.pricedItemVerification) {
    const issues = pricedEvidenceIssues(parsed, lines);
    if (issues.length) return issues;
  }
  if (!parsed?.illustratedRecovery && !parsed?.quotationVerification) return [];
  const audit = parsed.quotationVerification;
  if (!audit?.verified || !audit.manifest) return [quotationIssue("COVERAGE_INCOMPLETE",
    "Source specification coverage is unverified. Review the original PDF and confirm its source total, or prepare a re-extraction for review.", "source")];
  const rows = audit.manifest.sections.map(s => ({
    page: s.priceRegion.page, quantity: s.quantity, unitPrice: s.unitPrice, total: s.total, reference: s.reference,
  }));
  const verification = verifyQuotationManifest(audit.manifest, rows, {
    ...parsed, lineItems: [...lines].sort((a, b) => a.lineNumber - b.lineNumber).map(l => ({
      description: l.description, quantity: Number(l.quantity), unitPrice: Number(l.unitPriceHt), total: Number(l.totalHt),
    })),
  }, parsed.extractionCoverage?.pdfPageCount ?? 0);
  return verification.verified ? [] : [quotationIssue("SOURCE_INVENTORY_CHANGED",
    "Working rows no longer match the verified source inventory. Review the original source and confirm its total, or prepare a re-extraction.", "source")];
}

/** With a verified printed VAT table, the working figures count as checked only
 * when every item's VAT equals the printed rate and the TTC equals the PDF's. */
export function printedVatIssues(parsed: ParsedDocument, lines: DevisLineItem[], draft: ArchitectCorrectionDraft): QuotationIssue[] {
  const native = parsed.nativeTableRecovery;
  if (native?.parser !== CODED_LOT_TABLE_PARSER || !native.vatSummary || parsed.pricedItemVerification?.issues.length) return [];
  const printed = parsed.lineItems ?? [];
  const sorted = [...lines].sort((a, b) => a.lineNumber - b.lineNumber);
  if (sorted.length !== printed.length) return [];
  const byId = new Map(draft.lines.map(line => [line.id, line]));
  const issues = sorted.flatMap((line, i) => {
    const working = byId.get(line.id), rate = printed[i].vatRate;
    if (!rate || !working || working.kind !== "priced" || !working.included) return [];
    if (working.vatRate.trim() && Number(working.vatRate) === Number(rate)) return [];
    const page = native.evidence[i]?.pages[0];
    const issue = quotationIssue("VAT_RATE_MISMATCH",
      `Item ${i + 1}: VAT is ${working.vatRate.trim() ? `${working.vatRate}%` : "missing"}, but the PDF prints ${rate}%${page ? ` (page ${page})` : ""}. Set ${rate}% in Review/edit quotation.`,
      "financial", `line-${line.id}`, "vatRate", line.id);
    if (page) issue.target.page = page;
    return [issue];
  });
  if (issues.length) return issues;
  try {
    const totals = previewCorrectionTotals(draft);
    const printedTtc = correctionCents(native.amountTtc.toFixed(2));
    if (correctionCents(totals.ttc) !== printedTtc) return [quotationIssue("SOURCE_TTC_MISMATCH",
      `The working figures total ${totals.ttc} EUR including VAT, but the PDF prints ${correctionMoney(printedTtc)} EUR. Review discounts and excluded items in Review/edit quotation.`, "financial", "header")];
  } catch (error) {
    return [quotationIssue("FINANCIAL_BATCH_INVALID", `Complete the VAT treatment before approval: ${error instanceof Error ? error.message : "Invalid figures."}`, "financial", "header")];
  }
  return [];
}
