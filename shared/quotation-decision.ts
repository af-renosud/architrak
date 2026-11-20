/** Stable API vocabulary. Messages are presentation, never control flow. */
export type QuotationAction = "save_content" | "save_financial" | "approve" | "advance" | "client_link" | "sign";
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
