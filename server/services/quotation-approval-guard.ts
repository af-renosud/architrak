import { storage } from "../storage";
import type { ParsedDocument } from "../gmail/document-parser";
import { verifyQuotationManifest } from "./quotation-source-manifest";
import type { DevisLineItem } from "@shared/schema";

/** Re-evaluate live descriptions, not only the historical parser verdict. */
export async function quotationApprovalBlocker(devisId: number): Promise<string | null> {
  const devis = await storage.getDevis(devisId);
  if (!devis) return "Quotation not found.";
  const parsed = devis.aiExtractedData as ParsedDocument | null;
  if (!parsed?.illustratedRecovery && !parsed?.quotationVerification) return null;
  return quotationWorkingCoverageBlocker(parsed, await storage.getDevisLineItems(devisId));
}

export function quotationWorkingCoverageBlocker(parsed: ParsedDocument | null, lines: DevisLineItem[]): string | null {
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