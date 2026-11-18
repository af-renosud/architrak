import { storage } from "../storage";
import type { ParsedDocument } from "../gmail/document-parser";
import { verifyQuotationManifest } from "./quotation-source-manifest";
import type { DevisLineItem } from "@shared/schema";
import { architectFinancialBoundary, hasArchitectCorrection } from "./architect-quotation-correction";
import { createHash } from "node:crypto";
import { getDocumentBuffer } from "../storage/object-storage";
import { PRICED_EVIDENCE_PARSER, pricedRowsDigest } from "./quotation-priced-evidence";

/** Re-evaluate live descriptions, not only the historical parser verdict. */
export async function quotationApprovalBlocker(devisId: number): Promise<string | null> {
  const devis = await storage.getDevis(devisId);
  if (!devis) return "Quotation not found.";
  if (await hasArchitectCorrection(devisId)) return architectFinancialBoundary(devisId);
  const parsed = devis.aiExtractedData as ParsedDocument | null;
  if (parsed?.pricedItemVerification) {
    const evidence = parsed.pricedItemVerification;
    const rows = await storage.getDevisLineItems(devisId);
    const blocker = pricedEvidenceBlocker(parsed, rows);
    if (blocker) return blocker;
    if (parsed.nativeTableRecovery && (
      Math.round(Number(devis.amountHt) * 100) !== Math.round(parsed.nativeTableRecovery.amountHt * 100)
      || Math.round(Number(devis.amountTtc) * 100) !== Math.round(parsed.nativeTableRecovery.amountTtc * 100)))
      return "Working header totals differ from the independently read original totals. Use Edit working quotation to reconcile the source.";
    try {
      if (!devis.pdfStorageKey || createHash("sha256").update(await getDocumentBuffer(devis.pdfStorageKey)).digest("hex") !== evidence.sourceDigest)
        return "The original PDF no longer matches its verification. Review the current source before approval.";
    } catch { return "The original PDF cannot be verified right now. Retry before approval."; }
  }
  const translation = await storage.getDevisTranslation(devisId);
  if (translation?.status === "finalised" && (translation.headerTranslated as { humanReviewed?: boolean } | null)?.humanReviewed) return null;
  if (parsed && (parsed.documentType === "quotation" || Array.isArray(parsed.lineItems))
    && !parsed.pricedItemVerification && !parsed.illustratedRecovery && !parsed.quotationVerification)
    return "This quotation has no source-verification receipt. Review the original PDF in Edit working quotation and confirm its source total before approval.";
  if (!parsed?.illustratedRecovery && !parsed?.quotationVerification) return null;
  return quotationWorkingCoverageBlocker(parsed, await storage.getDevisLineItems(devisId));
}

export function pricedEvidenceBlocker(parsed: ParsedDocument, lines: DevisLineItem[]): string | null {
  const evidence = parsed.pricedItemVerification;
  if (!evidence) return null;
  if (evidence.parser !== PRICED_EVIDENCE_PARSER) return "Source verification is out of date. Review the original in Edit working quotation.";
  if (evidence.issues.length) return `Source review required: ${evidence.issues.slice(0, 3).map(issue =>
    `item ${issue.line}${issue.page ? ` (PDF page ${issue.page})` : ""}`).join(", ")}. Use Edit working quotation to review the source and confirm its total.`;
  const current = [...lines].sort((a, b) => a.lineNumber - b.lineNumber).map(line => ({
    description: line.description, total: Number(line.totalHt),
  }));
  if (pricedRowsDigest(current) !== evidence.rowsDigest) return "Working rows changed since source verification. Review and save them in Edit working quotation before approval.";
  const sum = current.reduce((total, line) => total + Math.round(line.total * 100), 0);
  if (!parsed.nativeTableRecovery || sum !== Math.round(parsed.nativeTableRecovery.amountHt * 100))
    return "The working item sum does not reconcile with the independently read original total.";
  return null;
}

export function quotationWorkingCoverageBlocker(parsed: ParsedDocument | null, lines: DevisLineItem[]): string | null {
  if (parsed?.pricedItemVerification) {
    const blocker = pricedEvidenceBlocker(parsed, lines);
    if (blocker) return blocker;
  }
  if (!parsed?.illustratedRecovery && !parsed?.quotationVerification) return null;
  const audit = parsed.quotationVerification;
  if (!audit?.verified || !audit.manifest) return "Source specification coverage is unverified. Review the original PDF and re-extract before approval.";
  const rows = audit.manifest.sections.map(s => ({
    page: s.priceRegion.page, quantity: s.quantity, unitPrice: s.unitPrice, total: s.total, reference: s.reference,
  }));
  const verification = verifyQuotationManifest(audit.manifest, rows, {
    ...parsed, lineItems: [...lines].sort((a, b) => a.lineNumber - b.lineNumber).map(l => ({
      description: l.description, quantity: Number(l.quantity), unitPrice: Number(l.unitPriceHt), total: Number(l.totalHt),
    })),
  }, parsed.extractionCoverage?.pdfPageCount ?? 0);
  return verification.verified ? null : "Working rows no longer match the verified source inventory. Re-extraction and review are required.";
}