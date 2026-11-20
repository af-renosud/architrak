import { hasRecordedSignature } from "./devis-stage-recovery";
import { quotationIssue, type QuotationIssue } from "./quotation-decision";
import type { Devis } from "./schema";

/** Local package prerequisites shared by list preflight and authoritative send.
 * Recipient/insurance/question authorisation remain orchestration-specific. */
export function quotationSigningIssues(d: Pick<Devis, "signOffStage" | "invoicingMode" | "lotId" | "lotRefText" | "descriptionUk"> &
  Partial<Devis>, translationStatus: string | null, requireMetadata = true): QuotationIssue[] {
  const issues: QuotationIssue[] = [];
  const add = (code: string, message: string, section: QuotationIssue["target"]["section"], field?: string) =>
    issues.push(quotationIssue(code, message, section, section, field));
  if (d.status === "void" || d.signOffStage === "void") add("QUOTATION_VOID", "This quotation has been cancelled.", "lifecycle");
  if (d.accountingState === "superseded") add("QUOTATION_REPLACED", "This quotation has been replaced. Open its replacement.", "lifecycle");
  if (hasRecordedSignature(d)) add("SIGNATURE_RECORDED", "Already signed — use the existing signed copy, not a new signature request.", "signature");
  if (d.signOffStage !== "approved_for_signing") add("SIGNING_STAGE_REQUIRED", `Stage is "${d.signOffStage}" — must reach "Approved for signing"`, "signature");
  if (!translationStatus || !["draft", "edited", "finalised"].includes(translationStatus))
    add("TRANSLATION_MISSING", `Translated PDF not generated (currently ${translationStatus ?? "missing"})`, "translation");
  else if (d.invoicingMode === "mode_b" && translationStatus !== "finalised")
    add("TRANSLATION_NOT_APPROVED", `Translation not finalised (currently ${translationStatus})`, "translation");
  if (requireMetadata && d.lotId == null && !(d.lotRefText ?? "").trim()) add("LOT_REQUIRED", "Lot reference missing", "financial", "lotId");
  if (requireMetadata && !(d.descriptionUk ?? "").trim()) add("ENGLISH_DESCRIPTION_REQUIRED", "English description missing", "translation", "descriptionUk");
  return issues;
}
