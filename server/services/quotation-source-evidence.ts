import type { ParsedDocument } from "../gmail/document-parser";
import type { DevisLineItem } from "@shared/schema";
import { quotationIssue, type QuotationIssue } from "@shared/quotation-decision";
import { verifyQuotationManifest } from "./quotation-source-manifest";
import { PRICED_EVIDENCE_PARSER, pricedRowsDigest } from "./quotation-priced-evidence";

export function pricedEvidenceIssues(parsed: ParsedDocument, lines: DevisLineItem[]): QuotationIssue[] {
  const evidence = parsed.pricedItemVerification;
  if (!evidence) return [];
  if (evidence.parser !== PRICED_EVIDENCE_PARSER) return [quotationIssue("SOURCE_RECEIPT_OUTDATED", "Source verification is out of date. Review the original in Edit working quotation.", "source")];
  if (evidence.issues.length) return evidence.issues.map(item => {
    const row = lines.find(l => l.lineNumber === item.line);
    const issue = quotationIssue("DESCRIPTION_CHARGE_UNVERIFIED",
      `Source review required: item ${item.line}${item.page ? ` (PDF page ${item.page})` : ""}. Review the original source and confirm its total.`,
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
