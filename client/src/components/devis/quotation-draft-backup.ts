import { architectCorrectionDraftSchema } from "@shared/architect-quotation";
import type { ArchitectCorrectionDraft, ArchitectCorrectionSnapshot } from "./architect-correction-model";

interface Backup { draft: ArchitectCorrectionDraft; original: ArchitectCorrectionSnapshot }
const key = (id: number) => `architrak:working-draft:${id}`;
export function readQuotationDraft(id: number): Backup | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(key(id)) ?? "null") as Backup | null;
    if (!value || typeof value.original?.version !== "string" ||
      !architectCorrectionDraftSchema.safeParse(value.draft).success ||
      !architectCorrectionDraftSchema.safeParse(value.original.draft).success) return null;
    return value;
  } catch { return null; }
}
export function keepQuotationDraft(id: number, backup: Backup | null) {
  // Storage can be unavailable in private browsing or full. The active draft still stays in memory.
  try {
    if (backup) sessionStorage.setItem(key(id), JSON.stringify(backup));
    else sessionStorage.removeItem(key(id));
  } catch { /* The download-backup action remains available. */ }
}
