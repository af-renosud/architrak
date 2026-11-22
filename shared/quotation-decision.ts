/** Stable API vocabulary. Messages are presentation, never control flow. */
export type QuotationAction = "register" | "prepare_translation" | "indicative_budget" | "save_content" | "save_financial" | "approve" | "advance" | "client_link" | "sign";
export interface QuotationIssue {
  code: string;
  severity: "blocker" | "warning" | "info";
  key: string;
  message: string;
  target: { section: "source" | "financial" | "translation" | "lifecycle" | "signature"; rowId?: number; field?: string; page?: number };
  resolution: "review_source" | "edit_figures" | "review_translation" | "refresh" | "open_signature" | "open_replacement";
}
export interface QuotationDecision {
  action: QuotationAction;
  version: string;
  contentVersion?: string;
  allowed: boolean;
  issues: QuotationIssue[];
}
export function quotationIssue(code: string, message: string, section: QuotationIssue["target"]["section"],
  key = section as string, field?: string, rowId?: number): QuotationIssue {
  return { code, severity: "blocker", key, message, target: { section, ...(field ? { field } : {}), ...(rowId ? { rowId } : {}) },
    resolution: section === "financial" ? "edit_figures" : section === "translation" ? "review_translation"
      : section === "signature" ? "open_signature" : section === "lifecycle" ? "open_replacement" : "review_source" };
}

/** Common lifecycle boundary. Draft preparation is independent of financial evidence. */
export function quotationLifecycleIssues(d: {
  status?: string | null; accountingState?: string | null; signOffStage?: string | null; pdfStorageKey?: string | null;
}, action: QuotationAction, archived = false): QuotationIssue[] {
  const issues: QuotationIssue[] = [];
  if (archived) issues.push(quotationIssue("PROJECT_ARCHIVED", "Archived projects are read-only.", "lifecycle"));
  if (d.accountingState === "superseded" || d.status === "superseded")
    issues.push(quotationIssue("QUOTATION_REPLACED", "This quotation has been replaced. Open its replacement.", "lifecycle"));
  if (["void", "cancelled"].includes(d.status ?? "") || d.signOffStage === "void")
    issues.push(quotationIssue("QUOTATION_VOID", "This quotation has been cancelled.", "lifecycle"));
  if (action === "register" || action === "indicative_budget") {
    if (!d.pdfStorageKey) issues.push(quotationIssue("SOURCE_UNAVAILABLE",
      "Attach the original quotation PDF before registering or reviewing its budget total.", "source"));
    if (action === "indicative_budget" && d.signOffStage === "client_rejected")
      issues.push(quotationIssue("QUOTATION_DECLINED", "Declined quotations cannot be included in the client budget.", "lifecycle"));
  }
  return issues;
}
