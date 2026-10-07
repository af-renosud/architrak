import { useEffect, useRef, useState } from "react";

export interface BulkDocument {
  id: number;
  name: string;
  eligible: boolean;
}
export interface BulkFailure { id: number; name: string; message: string }

/** Deliberately sequential: every request goes through the guarded single-record path. */
export async function runDocumentBatch(
  items: BulkDocument[],
  execute: (item: BulkDocument) => Promise<unknown>,
): Promise<{ succeeded: number[]; failures: BulkFailure[] }> {
  const succeeded: number[] = [];
  const failures: BulkFailure[] = [];
  for (const item of items) {
    try {
      await execute(item);
      succeeded.push(item.id);
    } catch (error) {
      failures.push({ id: item.id, name: item.name, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { succeeded, failures };
}

export function useBulkDocuments({
  items, scope, execute, onSettled,
}: {
  items: BulkDocument[];
  scope: string;
  execute: (id: number, reason: string) => Promise<unknown>;
  onSettled: () => void | Promise<unknown>;
}) {
  const [selection, setSelection] = useState<{ scope: string; ids: Set<number> }>({ scope, ids: new Set() });
  const [confirmation, setConfirmation] = useState<{ scope: string; items: BulkDocument[] } | null>(null);
  const [pending, setPending] = useState(false);
  const [refreshError, setRefreshError] = useState<{ scope: string; message: string } | null>(null);
  const [result, setResult] = useState<{ scope: string; succeeded: number; failures: BulkFailure[] } | null>(null);
  const busy = useRef(false);
  const latest = useRef({ items, scope, execute, onSettled });
  latest.current = { items, scope, execute, onSettled };
  const eligible = items.filter((item) => item.eligible);
  const eligibleKey = JSON.stringify(eligible.map((item) => item.id));
  const selected = eligible.filter((item) => selection.scope === scope && selection.ids.has(item.id));
  const ids = new Set(selected.map((item) => item.id));

  useEffect(() => {
    const visibleIds = new Set<number>(JSON.parse(eligibleKey));
    setSelection((old) => ({ scope, ids: new Set(old.scope === scope ? Array.from(old.ids).filter((id) => visibleIds.has(id)) : []) }));
  }, [scope, eligibleKey]);

  const toggle = (id: number, checked: boolean) => {
    if (busy.current || !eligible.some((item) => item.id === id)) return;
    setSelection((old) => {
      const next = new Set(old.scope === scope ? Array.from(old.ids).filter((value) => eligible.some((item) => item.id === value)) : []);
      if (checked) next.add(id); else next.delete(id);
      return { scope, ids: next };
    });
  };
  const selectAll = (checked: boolean) => {
    if (!busy.current) setSelection({ scope, ids: new Set(checked ? eligible.map((item) => item.id) : []) });
  };
  const clear = () => { if (!busy.current) setSelection({ scope, ids: new Set() }); };
  const confirm = async (reason: string) => {
    if (busy.current || !confirmation || confirmation.scope !== latest.current.scope) return;
    const batchScope = confirmation.scope;
    const batchExecute = latest.current.execute;
    const batchSettled = latest.current.onSettled;
    busy.current = true;
    setPending(true);
    const outcome = await runDocumentBatch(confirmation.items, async (item) => {
      if (latest.current.scope !== batchScope) throw new Error("List changed. Not processed.");
      if (!latest.current.items.some((current) => current.id === item.id && current.eligible)) {
        throw new Error("No longer eligible. Refresh and review this document.");
      }
      return batchExecute(item.id, reason.trim());
    });
    setSelection((old) => ({ ...old, ids: new Set(Array.from(old.ids).filter((id) => !outcome.succeeded.includes(id))) }));
    setResult({ scope: batchScope, succeeded: outcome.succeeded.length, failures: outcome.failures });
    setConfirmation(null);
    try { await batchSettled(); }
    catch (error) { setRefreshError({ scope: batchScope, message: error instanceof Error ? error.message : "Refresh failed. Reload the list before continuing." }); }
    finally { busy.current = false; setPending(false); }
  };
  return {
    ids, selected, eligibleCount: eligible.length, pending,
    allChecked: selected.length === 0 ? false : selected.length === eligible.length ? true : "indeterminate" as const,
    toggle, selectAll, clear,
    openConfirmation: () => { if (!busy.current && selected.length) { setResult(null); setRefreshError(null); setConfirmation({ scope, items: selected }); } },
    closeConfirmation: () => { if (!busy.current) setConfirmation(null); },
    confirmationItems: confirmation?.scope === scope ? confirmation.items : [],
    confirmationOpen: confirmation?.scope === scope,
    result: result?.scope === scope ? result : null,
    refreshError: refreshError?.scope === scope ? refreshError.message : null,
    confirm,
  };
}
export type BulkDocumentsSelection = ReturnType<typeof useBulkDocuments>;
