import type { InsertDevisTranslation } from "@shared/schema";

/** Approval belongs to exact content, never to the mutable translation row. */
export function translationEditInvalidation(data: Partial<InsertDevisTranslation>) {
  if (data.lineTranslations === undefined && data.headerTranslated === undefined) return {};
  return {
    status: data.status && data.status !== "finalised" ? data.status : "edited",
    approvedAt: null, approvedBy: null, approvedByEmail: null,
    translatedPdfStorageKey: null, combinedPdfStorageKey: null,
  };
}