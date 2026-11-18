import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { apiRequest } from "@/lib/queryClient";
import { quotationWorkBlocked, useQuotationWork } from "./quotation-review-state";

export interface TranslationReadiness { version: string; status: string; blockers: Array<{ key: string; message: string }> }
export function QuotationApprovalReview({ devisId, onLocate, disabled = false, onRefreshWorking }: {
  devisId: number; onLocate: (key: string) => void; disabled?: boolean; onRefreshWorking?: () => Promise<unknown>;
}) {
  const client = useQueryClient();
  const work = useQuotationWork(devisId);
  const [reviewedVersion, setReviewedVersion] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lock = useRef(false);
  const refreshRef = useRef(onRefreshWorking);
  refreshRef.current = onRefreshWorking;
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [syncEpoch, setSyncEpoch] = useState(0);
  const readiness = useQuery<TranslationReadiness>({
    queryKey: ["/api/devis", devisId, "translation", "readiness", work.epoch],
    queryFn: async () => {
      const result = await (await apiRequest("GET", `/api/devis/${devisId}/translation/readiness`)).json() as TranslationReadiness;
      if (!result || typeof result.version !== "string" || typeof result.status !== "string" || !Array.isArray(result.blockers)) {
        throw new Error("The latest review checklist is unavailable.");
      }
      return result;
    },
    enabled: !work.blocked, retry: false, staleTime: 0,
  });
  useEffect(() => { setReviewedVersion(null); }, [work.epoch, readiness.data?.version]);
  useEffect(() => {
    if (!readiness.data || !refreshRef.current) return;
    let active = true;
    setSyncing(true); setSyncError(null);
    void refreshRef.current().catch(() => {
      if (active) setSyncError("The working quotation could not be refreshed. Approval remains blocked.");
    }).finally(() => { if (active) setSyncing(false); });
    return () => { active = false; };
  }, [readiness.data?.version, syncEpoch]);
  const finalise = useMutation({
    mutationFn: async () => {
      if (lock.current || disabled || syncing || syncError || quotationWorkBlocked(devisId) || !reviewedVersion || readiness.isFetching ||
        reviewedVersion !== readiness.data?.version || readiness.data.blockers.length) throw new Error("Save all changes and review the latest checklist first.");
      lock.current = true;
      try {
        return await (await apiRequest("POST", `/api/devis/${devisId}/translation/finalise`, { expectedVersion: reviewedVersion })).json();
      } finally { lock.current = false; }
    },
    onSuccess: () => {
      setReviewedVersion(null); setError(null);
      void client.invalidateQueries({ queryKey: ["/api/devis", devisId, "translation"] });
      void client.invalidateQueries({ queryKey: ["/api/devis", devisId, "architect-correction"] });
      void client.invalidateQueries({ predicate: query => query.queryKey.includes("devis-readiness") });
    },
    onError: (cause: Error) => {
      setError(`${cause.message} Your draft is preserved. Refresh and review the latest version before approving.`);
      setReviewedVersion(null); void readiness.refetch();
    },
  });
  const approved = readiness.data?.status === "finalised";
  const blocked = disabled || syncing || !!syncError || work.blocked || readiness.isFetching || readiness.isError || !readiness.data || !!readiness.data.blockers.length;
  return <section className="review-checklist space-y-3" aria-label="Review and approve">
    <div><h3 className="text-sm font-semibold">Review and approve</h3>
      <p className="text-xs mt-1">1. Review/edit against the original PDF. 2. Save wording, figures and context. 3. Review this latest checklist and approve.</p></div>
    <p role="status" data-workflow-attention={work.blocked || undefined} className="text-xs">{work.blocked ? "Unsaved work · approval is blocked until all saves and image uploads settle." :
      readiness.isFetching || syncing ? "Checking the latest saved quotation…" : approved ? "Approved · this saved version is ready to share." : "Saved version · original PDF remains the legal reference."}</p>
    {work.messages.map((message, i) => <p key={i} className="text-xs">{message}</p>)}
    {readiness.isError && <div role="alert" className="text-xs">Checklist could not be loaded. Approval is unavailable. <Button size="sm" variant="outline" onClick={() => void readiness.refetch()}>Retry checklist</Button></div>}
    {syncError && <div role="alert" className="text-xs">{syncError} <Button type="button" size="sm" variant="outline" onClick={() => setSyncEpoch(value => value + 1)}>Retry working quotation</Button></div>}
    {!work.blocked && readiness.data?.blockers.map((blocker, index) => <button type="button" key={`${blocker.key}-${index}`}
      onClick={() => onLocate(blocker.key)} className="block text-left text-xs underline underline-offset-4">{blocker.message}</button>)}
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    {!approved && <>
      <label className="flex items-start gap-2 text-xs"><input type="checkbox" checked={!!reviewedVersion && reviewedVersion === readiness.data?.version}
        disabled={blocked || finalise.isPending} onChange={event => { setError(null); setReviewedVersion(event.target.checked ? readiness.data!.version : null); }} />
        I reviewed the original PDF, French and English wording, actual figures, and client context in this latest saved version.</label>
      <Button type="button" size="sm" disabled={blocked || !reviewedVersion || finalise.isPending}
        onClick={() => finalise.mutate()}>{finalise.isPending ? "Approving…" : "Approve reviewed quotation"}</Button>
    </>}
  </section>;
}
