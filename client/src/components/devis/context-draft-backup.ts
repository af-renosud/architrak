import { contextDocSchema, type ContextDoc } from "@shared/context-doc";

export interface ContextDraftBackup { document: ContextDoc; baseDocument: ContextDoc | null; baseRevision: number }
const key = (devisId: number, lineItemId: number) => `architrak:context-draft:${devisId}:${lineItemId}`;
export function readContextDraft(devisId: number, lineItemId: number): ContextDraftBackup | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(key(devisId, lineItemId)) ?? "null") as ContextDraftBackup | null;
    if (!value || !Number.isInteger(value.baseRevision) || value.baseRevision < 0 ||
      !contextDocSchema.safeParse(value.document).success ||
      value.baseDocument !== null && !contextDocSchema.safeParse(value.baseDocument).success) return null;
    return value;
  } catch { return null; }
}
export function keepContextDraft(devisId: number, lineItemId: number, value: ContextDraftBackup | null) {
  try {
    if (value) sessionStorage.setItem(key(devisId, lineItemId), JSON.stringify(value));
    else sessionStorage.removeItem(key(devisId, lineItemId));
  } catch { /* An unavailable browser store must not interrupt the active editor. */ }
}
