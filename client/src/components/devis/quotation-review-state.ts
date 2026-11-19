import { useSyncExternalStore } from "react";

type Work = { blocked: boolean; message: string };
const work = new Map<number, Map<string, Work>>();
const versions = new Map<number, number>();
const listeners = new Set<() => void>();
export function setQuotationWork(id: number, key: string, blocked: boolean, message = "") {
  const entries = work.get(id) ?? new Map<string, Work>();
  const old = entries.get(key);
  if (old?.blocked === blocked && old.message === message) return;
  entries.set(key, { blocked, message }); work.set(id, entries);
  versions.set(id, (versions.get(id) ?? 0) + 1);
  listeners.forEach(listener => listener());
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
