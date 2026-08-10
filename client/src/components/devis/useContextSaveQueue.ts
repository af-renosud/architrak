import { useEffect, useRef, useState } from "react";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import type { ContextDoc } from "@shared/context-doc";
import type { DevisLineContext } from "@shared/schema";

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
 *      * anything else → genuine cross-window edit: rebase ONCE and retry
 *        with a notice (deliberate last-writer-wins); a second consecutive
 *        409 surfaces the conflict instead of looping.
 */
export function useContextSaveQueue(
  devisId: number,
  lineItemId: number,
  context: DevisLineContext | null,
) {
  const { toast } = useToast();
  const revisionRef = useRef<number>(context?.revision ?? 0);
  const [saveState, setSaveState] = useState<ContextSaveState>("idle");

  const pendingDocRef = useRef<ContextDoc | null>(null);
  const inFlightRef = useRef(false);
  const inFlightDocStrRef = useRef<string | null>(null);
  const rebasedRef = useRef(false);
  const lastSavedStrRef = useRef<string | null>(
    context ? JSON.stringify(context.document) : null,
  );

  // Re-sync the revision baseline when fresher data arrives from the server
  // (e.g. a query refetch after our own save). Only adopt the newer revision
  // when the server document is exactly what this client last saved — a
  // differing document means another window edited, and the stale revision
  // must be kept so the next save 409s and surfaces the conflict.
  useEffect(() => {
    const rev = context?.revision ?? 0;
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
    if (inFlightRef.current) return;
    const doc = pendingDocRef.current;
    if (!doc) return;
    pendingDocRef.current = null;
    const docStr = JSON.stringify(doc);
    inFlightRef.current = true;
    inFlightDocStrRef.current = docStr;
    setSaveState("saving");
    try {
      const saved = await putDocument(doc);
      revisionRef.current = saved.revision;
      lastSavedStrRef.current = docStr;
      rebasedRef.current = false;
      setSaveState("saved");
    } catch (err) {
      const status = (err as Error & { status?: number }).status;
      if (status === 409 && !rebasedRef.current) {
        try {
          const latest = await fetchLatest();
          revisionRef.current = latest?.revision ?? 0;
          const latestStr = latest ? JSON.stringify(latest.document) : null;
          if (latestStr !== null && latestStr === docStr) {
            // Self-conflict: the server already holds exactly this content
            // (a duplicate save landed first). Nothing to redo.
            lastSavedStrRef.current = docStr;
            rebasedRef.current = false;
            setSaveState("saved");
          } else {
            rebasedRef.current = true;
            // Retry with the user's content unless they typed something newer.
            if (!pendingDocRef.current) pendingDocRef.current = doc;
            const selfStale =
              latestStr !== null &&
              lastSavedStrRef.current !== null &&
              latestStr === lastSavedStrRef.current;
            if (!selfStale) {
              toast({
                title: "Context edited elsewhere",
                description:
                  "This line was updated in another window — your version is being saved over it.",
              });
            }
          }
        } catch {
          setSaveState("error");
        }
      } else if (status === 409) {
        rebasedRef.current = false;
        setSaveState("conflict");
        queryClient.invalidateQueries({ queryKey: ["/api/devis", devisId, "line-contexts"] });
        toast({
          title: "Context changed elsewhere",
          description:
            "This line's context keeps changing in another window. Reload the page before editing further.",
          variant: "destructive",
        });
      } else {
        setSaveState("error");
        toast({
          title: "Context save failed",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        });
      }
    } finally {
      inFlightRef.current = false;
      inFlightDocStrRef.current = null;
      if (pendingDocRef.current) void pumpSaves();
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
    void pumpSaves();
  };

  const hasPendingSave = () => pendingDocRef.current !== null;

  return { saveState, setSaveState, enqueue, revisionRef, hasPendingSave };
}
