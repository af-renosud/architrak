import { useSyncExternalStore } from "react";

type Work = { blocked: boolean; message: string; document?: string };
const work = new Map<number, Map<string, Work>>();
const versions = new Map<number, number>();
const listeners = new Set<() => void>();
export function setQuotationWork(id: number, key: string, blocked: boolean, message = "", document?: string) {
  const entries = work.get(id) ?? new Map<string, Work>();
  const old = entries.get(key);
  if (!blocked && !old || old?.blocked === blocked && old.message === message && old.document === document) return;
  if (blocked) { entries.set(key, { blocked, message, document }); work.set(id, entries); }
  else { entries.delete(key); if (!entries.size) work.delete(id); }
  versions.set(id, (versions.get(id) ?? 0) + 1);
  listeners.forEach(listener => listener());
}
/** A recovered save may finish after its original editing surface unmounted.
 * Clear only queue blockers for the exact persisted document, never debounce,
 * upload, request or differing-draft blockers. */
export function settleSavedContextWork(id: number, lineItemId: number, document: string) {
  for (const [key, entry] of Array.from(work.get(id)?.entries() ?? [])) {
    if (new RegExp(`^context:[^:]+:${lineItemId}$`).test(key) && entry.document === document)
      setQuotationWork(id, key, false);
  }
}
export function quotationWorkBlocked(id: number, exceptKey?: string) {
  return Array.from(work.get(id)?.entries() ?? []).some(([key, entry]) => key !== exceptKey && entry.blocked);
}
export function useQuotationWork(id: number) {
  const epoch = useSyncExternalStore(
    listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => versions.get(id) ?? 0,
  );
  return { epoch, blocked: quotationWorkBlocked(id),
    issues: Array.from(work.get(id)?.entries() ?? []).filter(([, entry]) => entry.blocked).map(([key, entry]) => ({ key, message: entry.message })),
    messages: Array.from(work.get(id)?.values() ?? []).filter(entry => entry.blocked).map(entry => entry.message) };
}
