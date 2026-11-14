import { emailHasFinancialAdmission, emailNeedsAttention, emailVisibleByDefault } from "@shared/email-financial-gate";

interface FilterableDocument {
  extractedData?: unknown;
  devisId?: number | null;
  invoiceId?: number | null;
  extractionStatus: string;
  projectId: number | null;
  documentType: string;
  emailSubject?: string | null;
  emailFrom?: string | null;
  attachmentFileName?: string | null;
}

export function matchesEmailDocumentFilters(
  doc: FilterableDocument,
  status: string,
  type: string,
  search: string,
  showRemoved = false,
): boolean {
  if (!emailHasFinancialAdmission(doc)) return false;
  if (status === "all_statuses") {
    if (doc.extractionStatus === "skipped" && !showRemoved) return false;
  } else if (status === "all") {
    if (!emailVisibleByDefault(doc)) return false;
  } else if (status === "needs_attention") {
    if (!emailNeedsAttention(doc)) return false;
  } else if (status === "needs_project") {
    if (doc.extractionStatus !== "needs_review" || doc.projectId != null) return false;
  } else if (doc.extractionStatus !== status) return false;

  if (type !== "all" && doc.documentType !== type) return false;
  const query = search.trim().toLowerCase();
  return !query || [doc.emailSubject, doc.emailFrom, doc.attachmentFileName]
    .some(value => value?.toLowerCase().includes(query));
}
