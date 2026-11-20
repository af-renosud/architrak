import { useEffect, useRef, useState } from "react";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import type { ContextDoc } from "@shared/context-doc";
import type { DevisLineContext } from "@shared/schema";
import { setQuotationWork, settleSavedContextWork } from "./quotation-review-state";
import { keepContextDraft, readContextDraft } from "./context-draft-backup";

export type ContextSaveState = "idle" | "saving" | "saved" | "conflict" | "error";

/**
 * Single-flight save queue for one devis line's context document.
 *
 * Guarantees (regression: false "edited elsewhere" conflicts, Task 364):
 *  - Saves are serialized: at most one PUT in flight; newer snapshots
 *    coalesce (only the latest is kept).
 *  - The revision baseline re-syncs when fresher server data arrives via
 *    props/query updates — but ONLY when the server document matches what
 *    this client last saved (our own save echoed back). Adopting a foreign
 *    revision would silently last-write-win over another window's edit.
 *  - A flush of an already-saved (or currently-in-flight) snapshot is a
 *    no-op, so blur + unmount can't enqueue duplicate saves.
 *  - On a 409, the server state is re-fetched and compared before declaring
 *    a cross-window conflict:
 *      * server already holds exactly the content we tried to save
 *        → self-conflict (duplicate save landed first): adopt revision,
 *          mark saved, no toast.
 *      * server holds what we last saved → our baseRevision was merely
 *        stale: rebase and retry silently.
 *      * anything else → pause and compare; never overwrite a foreign edit.
 */
export function useContextSaveQueue(
  devisId: number,
  lineItemId: number,
  context: DevisLineContext | null,
  enabled = true,
  workScope = "workspace",
) {
  const { toast } = useToast();
  const recovered = useRef(enabled ? readContextDraft(devisId, lineItemId) : null);
  const revisionRef = useRef<number>(recovered.current?.baseRevision ?? context?.revision ?? 0);
  const [saveState, setSaveState] = useState<ContextSaveState>("idle");
  const [conflict, setConflict] = useState<{ revision: number; document: ContextDoc; mine: ContextDoc; base: ContextDoc | null } | null>(null);
  const pausedRef = useRef(false);
  const workKey = `context:${workScope}:${lineItemId}`;
  const markWork = (blocked: boolean, message = "") => setQuotationWork(devisId, workKey, blocked, message,
    blocked ? pendingDocRef.current ? JSON.stringify(pendingDocRef.current) : inFlightDocStrRef.current ?? undefined : undefined);

  const pendingDocRef = useRef<ContextDoc | null>(recovered.current?.document ?? null);
  const inFlightRef = useRef(false);
  const inFlightDocStrRef = useRef<string | null>(null);
  const rebasedRef = useRef(false);
  const lastSavedStrRef = useRef<string | null>(
    recovered.current ? recovered.current.baseDocument ? JSON.stringify(recovered.current.baseDocument) : null :
      context ? JSON.stringify(context.document) : null,
  );
  const rememberDraft = (document: ContextDoc) => keepContextDraft(devisId, lineItemId, {
    document, baseRevision: revisionRef.current,
    baseDocument: lastSavedStrRef.current ? JSON.parse(lastSavedStrRef.current) : null,
  });
  const settleBackup = (document: ContextDoc, revision: number) => {
    const backup = readContextDraft(devisId, lineItemId);
    if (!backup || JSON.stringify(backup.document) === JSON.stringify(document)) keepContextDraft(devisId, lineItemId, null);
    else keepContextDraft(devisId, lineItemId, { ...backup, baseDocument: document, baseRevision: revision });
  };

  // Re-sync the revision baseline when fresher data arrives from the server
  // (e.g. a query refetch after our own save). Only adopt the newer revision
  // when the server document is exactly what this client last saved — a
  // differing document means another window edited, and the stale revision
  // must be kept so the next save 409s and surfaces the conflict.
  useEffect(() => {
    const rev = context?.revision ?? 0;
    // Another editing surface may have saved this exact draft. Settle only
    // this queue's matching content, never unrelated/newer local edits.
    if (context && !inFlightRef.current && pendingDocRef.current &&
      rev >= revisionRef.current && JSON.stringify(context.document) === JSON.stringify(pendingDocRef.current)) {
      revisionRef.current = rev;
      lastSavedStrRef.current = JSON.stringify(context.document);
      pendingDocRef.current = null; pausedRef.current = false; rebasedRef.current = false;
      setConflict(null); setSaveState("saved"); markWork(false);
      settleBackup(context.document as ContextDoc, rev);
    }
    if (
      rev > revisionRef.current &&
      !inFlightRef.current &&
      !pendingDocRef.current &&
      lastSavedStrRef.current !== null &&
      JSON.stringify(context?.document) === lastSavedStrRef.current
    ) {
      revisionRef.current = rev;
    }
  }, [context]);

  const putDocument = async (document: ContextDoc): Promise<DevisLineContext> => {
    const res = await fetch(`/api/devis/${devisId}/line-contexts/${lineItemId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ document, baseRevision: revisionRef.current }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ message: res.statusText }));
      const err = new Error(body.message || "Save failed") as Error & { status?: number };
      err.status = res.status;
      throw err;
    }
    return (await res.json()) as DevisLineContext;
  };

  const fetchLatest = async (): Promise<{ revision: number; document: unknown } | null> => {
    const res = await fetch(`/api/devis/${devisId}/line-contexts`, { credentials: "include" });
    if (!res.ok) throw new Error("Could not reload context state");
    const body = (await res.json()) as { contexts: DevisLineContext[] };
    const c = body.contexts.find((x) => x.devisLineItemId === lineItemId);
    return c ? { revision: c.revision, document: c.document } : null;
  };

  const pumpSaves = async () => {
    if (inFlightRef.current || pausedRef.current) return;
    const doc = pendingDocRef.current;
    if (!doc) return;
    pendingDocRef.current = null;
    const docStr = JSON.stringify(doc);
    inFlightRef.current = true;
    const requestKey = `context-request:${lineItemId}:${crypto.randomUUID()}`;
    setQuotationWork(devisId, requestKey, true, "A context save request is in progress.");
    inFlightDocStrRef.current = docStr;
    setSaveState("saving");
    markWork(true, "Line context is saving.");
    try {
      const saved = await putDocument(doc);
      settleSavedContextWork(devisId, lineItemId, JSON.stringify(saved.document));
      revisionRef.current = saved.revision;
      lastSavedStrRef.current = docStr;
      settleBackup(doc, saved.revision);
      rebasedRef.current = false;
      setSaveState("saved");
      if (!pendingDocRef.current) markWork(false);
      // Keep the query cache fresh (staleTime is Infinity): without this, an
      // editor remounted after a tab switch initialises from the stale cached
      // document and the just-saved content silently vanishes from the UI
      // until a full reload.
      queryClient.invalidateQueries({ queryKey: ["/api/devis", devisId, "line-contexts"] });
      queryClient.invalidateQueries({ queryKey: ["/api/devis", devisId, "architect-correction"] });
    } catch (err) {
      const status = (err as Error & { status?: number }).status;
      if (status === 409 && !rebasedRef.current) {
        try {
          const latest = await fetchLatest();
          const latestStr = latest ? JSON.stringify(latest.document) : null;
          if (latestStr !== null && latestStr === docStr) {
            // Self-conflict: the server already holds exactly this content
            // (a duplicate save landed first). Nothing to redo.
            lastSavedStrRef.current = docStr;
            settleSavedContextWork(devisId, lineItemId, docStr);
            revisionRef.current = latest!.revision;
            settleBackup(doc, latest!.revision);
            rebasedRef.current = false;
            setSaveState("saved");
            if (!pendingDocRef.current) markWork(false);
            queryClient.invalidateQueries({ queryKey: ["/api/devis", devisId, "line-contexts"] });
            queryClient.invalidateQueries({ queryKey: ["/api/devis", devisId, "architect-correction"] });
          } else {
            rebasedRef.current = true;
            // Retry with the user's content unless they typed something newer.
            if (!pendingDocRef.current) pendingDocRef.current = doc;
            const selfStale =
              latestStr !== null &&
              lastSavedStrRef.current !== null &&
              latestStr === lastSavedStrRef.current;
            if (selfStale) revisionRef.current = latest!.revision;
            else {
              pausedRef.current = true;
              setSaveState("conflict");
              markWork(true, "Context changed elsewhere. Compare both versions before saving.");
              setConflict({ revision: latest?.revision ?? 0,
                document: (latest?.document ?? { type: "doc", content: [] }) as ContextDoc,
                mine: pendingDocRef.current ?? doc,
                base: lastSavedStrRef.current ? JSON.parse(lastSavedStrRef.current) : null });
            }
          }
        } catch {
          pausedRef.current = true;
          if (!pendingDocRef.current) pendingDocRef.current = doc;
          markWork(true, "Context could not be refreshed. Retry saving.");
          setSaveState("error");
        }
      } else if (status === 409) {
        pausedRef.current = true;
        if (!pendingDocRef.current) pendingDocRef.current = doc;
        markWork(true, "Context changed again. Retry to compare the latest version.");
        rebasedRef.current = false;
        setSaveState("conflict");
        queryClient.invalidateQueries({ queryKey: ["/api/devis", devisId, "line-contexts"] });
        toast({
          title: "Context changed elsewhere",
          description:
            "Your context draft is preserved. Compare the latest context here before saving again.",
          variant: "destructive",
        });
      } else {
        pausedRef.current = true;
        if (!pendingDocRef.current) pendingDocRef.current = doc;
        markWork(true, "Context save failed. Your draft is preserved; retry saving.");
        setSaveState("error");
        toast({
          title: "Context save failed",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        });
      }
    } finally {
      setQuotationWork(devisId, requestKey, false);
      inFlightRef.current = false;
      inFlightDocStrRef.current = null;
      if (pendingDocRef.current && !pausedRef.current) void pumpSaves();
    }
  };

  /** Enqueue a snapshot; duplicate flushes of saved/in-flight content no-op. */
  const enqueue = (doc: ContextDoc) => {
    const str = JSON.stringify(doc);
    if (
      !pendingDocRef.current &&
      (str === lastSavedStrRef.current ||
        (inFlightRef.current && str === inFlightDocStrRef.current))
    ) {
      return;
    }
    pendingDocRef.current = doc;
    rememberDraft(doc);
    markWork(true, pausedRef.current ? "Context save needs attention. Open this context to retry or resolve the conflict." : "Unsaved line context.");
    void pumpSaves();
  };

  const hasPendingSave = () => pendingDocRef.current !== null || inFlightRef.current || pausedRef.current;
  const retry = () => { pausedRef.current = false; rebasedRef.current = false; void pumpSaves(); };
  const resolveConflict = (choice: "mine" | "latest") => {
    if (!conflict) return null;
    revisionRef.current = conflict.revision;
    lastSavedStrRef.current = JSON.stringify(conflict.document);
    const chosen = choice === "mine" ? pendingDocRef.current ?? conflict.mine : conflict.document;
    pendingDocRef.current = null; pausedRef.current = false; rebasedRef.current = false;
    setConflict(null);
    if (choice === "mine") enqueue(chosen);
    else {
      setSaveState("saved"); markWork(false);
      keepContextDraft(devisId, lineItemId, null);
      queryClient.invalidateQueries({ queryKey: ["/api/devis", devisId, "line-contexts"] });
      queryClient.invalidateQueries({ queryKey: ["/api/devis", devisId, "architect-correction"] });
    }
    return chosen;
  };
  useEffect(() => {
    if (recovered.current && enabled) {
      markWork(true, "Recovered unsaved context is being checked and saved.");
      void pumpSaves();
    }
    // Recover once per mounted editor; the existing revision guard handles duplicate unmount flushes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Adopt a fresh server snapshot as the new save baseline (revision + last
   * saved content). Used when the EDITOR re-syncs its content from fresher
   * query data (e.g. remounting after a tab switch while an unmount flush
   * was still in flight). Refuses while a save is pending or in flight —
   * the baseline must never move under an unsettled save.
   */
  const adoptServerState = (c: DevisLineContext): boolean => {
    if (inFlightRef.current || pendingDocRef.current || pausedRef.current) return false;
    revisionRef.current = c.revision;
    lastSavedStrRef.current = JSON.stringify(c.document);
    return true;
  };

  return { saveState, setSaveState, enqueue, revisionRef, hasPendingSave, adoptServerState, conflict, resolveConflict, retry,
    restoredDocument: recovered.current?.document, rememberDraft };
}
