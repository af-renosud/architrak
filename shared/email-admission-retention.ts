import { emailHasFinancialAdmission, type FinancialEmailEvidence } from "./email-financial-gate";
export const UNVERIFIED_PDF_RETENTION_MS = 7 * 24 * 60 * 60_000;
/** User-confirmed plan; both filename and exact bytes must match. */
const CONFIRMED_PLAN_HASH = "f95dbff4dd9875ea010c9f60416beed7230d38755db1c55f3c479c9be7227ce9";
export function unverifiedPdfCleanupReason(doc: FinancialEmailEvidence & {
  projectId?: number | null; attachmentFileName?: string | null; contentFingerprint?: string | null;
  createdAt: Date | string; processingAttempts?: number | null;
}, now = Date.now()): "confirmed_plan" | "unverified_retention_expired" | null {
  if (doc.projectId != null || emailHasFinancialAdmission(doc) || doc.extractionStatus === "processing") return null;
  if (!["failed", "financial_unreadable", "pending"].includes(doc.extractionStatus)) return null;
  if (doc.attachmentFileName === "V14_LIVERMORE_opt.pdf" && doc.contentFingerprint === CONFIRMED_PLAN_HASH) return "confirmed_plan";
  if (["failed", "financial_unreadable"].includes(doc.extractionStatus) &&
      now - new Date(doc.createdAt).getTime() >= UNVERIFIED_PDF_RETENTION_MS) return "unverified_retention_expired";
  return null;
}
