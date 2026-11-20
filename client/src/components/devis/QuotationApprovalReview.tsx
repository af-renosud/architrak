import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { apiRequest } from "@/lib/queryClient";
import { quotationWorkBlocked, useQuotationWork } from "./quotation-review-state";
import type { QuotationIssue } from "@shared/quotation-decision";

export type TranslationReadinessBlocker = Pick<QuotationIssue, "key" | "message"> & Partial<Omit<QuotationIssue, "key" | "message">>;
export interface TranslationReadiness {
  version: string; status: string; blockers: TranslationReadinessBlocker[];
  sendingPrerequisites?: QuotationIssue[];
}
export function QuotationApprovalReview({ devisId, onLocate, disabled = false, onRefreshWorking, onCloseEditor, onReadiness }: {
  devisId: number; onLocate: (key: string, target?: QuotationIssue["target"]) => void; disabled?: boolean;
  onRefreshWorking?: () => Promise<unknown>; onCloseEditor?: () => void; onReadiness?: (readiness: TranslationReadiness) => void;
}) {
  const client = useQueryClient();
  const work = useQuotationWork(devisId);
  const [reviewedVersion, setReviewedVersion] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lock = useRef(false);
  const refreshRef = useRef(onRefreshWorking);
  refreshRef.current = onRefreshWorking;
  const readinessRef = useRef(onReadiness);
  readinessRef.current = onReadiness;
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
  useEffect(() => { if (readiness.data) readinessRef.current?.(readiness.data); }, [readiness.data]);
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
        return await (await apiRequest("POST", `/api/devis/${devisId}/translation/finalise`, { expectedVersion: reviewedVersion, confirmedReview: true })).json();
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
      <p className="text-xs mt-1">Compare with the original PDF. Save only if you made changes, then confirm your review and approve. No correction is required when the quotation is already correct.</p></div>
    <p role="status" data-workflow-attention={work.blocked || undefined} className="text-xs">{work.blocked ? "Unsaved work · approval is blocked until all saves and image uploads settle." :
      readiness.isFetching || syncing ? "Checking the latest saved quotation…" : approved ? "Approved saved translation · sending requirements are checked separately." : "Saved version · original PDF remains the legal reference."}</p>
    {work.issues.map(issue => {
      const match = issue.key.match(/^(?:context(?:-[a-z]+)?|image-request):(?:(?:inline|workspace):)?(\d+)/);
      return <div key={issue.key} className="text-xs">
        <span>{issue.message}</span>
        {match && <Button type="button" variant="ghost" className="underline" size="sm"
          onClick={() => issue.key.includes(":inline:") && onCloseEditor ? onCloseEditor() :
            onLocate(`line-${match[1]}`, { section: "translation", rowId: Number(match[1]), field: "context" })}>
          {issue.key.includes(":inline:") && onCloseEditor ? "Close editor to resolve inline context" : "Go to context"}</Button>}
      </div>;
    })}
    {work.blocked && <p className="text-xs">You can close this editor without discarding context. Resolve any failed save or conflicting edit in the affected context box; approval stays protected until it is saved.</p>}
    {readiness.isError && <div role="alert" className="text-xs">Checklist could not be loaded. Approval is unavailable. <Button size="sm" variant="outline" onClick={() => void readiness.refetch()}>Retry checklist</Button></div>}
    {syncError && <div role="alert" className="text-xs">{syncError} <Button type="button" size="sm" variant="outline" onClick={() => setSyncEpoch(value => value + 1)}>Retry working quotation</Button></div>}
    {!work.blocked && readiness.data && ([
      { id: "source", title: "Source & figures", matches: (issue: TranslationReadinessBlocker) =>
        issue.target?.section === "source" || issue.target?.section === "financial" || !!issue.code?.startsWith("SOURCE_") },
      { id: "content", title: "Saved content", matches: (issue: TranslationReadinessBlocker) =>
        issue.target?.section !== "source" && issue.target?.section !== "financial" && !issue.code?.startsWith("SOURCE_") },
    ]).map(group => {
      const issues = readiness.data.blockers.filter(group.matches);
      return <section key={group.id} className="review-checklist-group space-y-2" aria-label={group.title}>
        <h4 className="text-xs font-semibold">{group.title}</h4>
        {issues.length ? issues.map((blocker, index) => <button type="button" key={`${blocker.key}-${index}`}
          onClick={() => onLocate(blocker.key, blocker.target)} className="block text-left text-xs underline underline-offset-4">{blocker.message}</button>)
          : <p className="text-xs text-muted-foreground">No approval blockers reported for this saved version.</p>}
      </section>;
    })}
    <details className="text-xs border-t pt-2">
      <summary className="cursor-pointer font-semibold">Sending prerequisites · separate from translation approval</summary>
      <p className="mt-2 text-muted-foreground">Client-link, commercial and signature requirements are checked when you send. They are not additional translation approval checks.</p>
      {!!readiness.data?.sendingPrerequisites?.length && <ul className="mt-2 space-y-1">{readiness.data.sendingPrerequisites.map(issue =>
        <li key={`${issue.code}:${issue.key}`}>{issue.message}</li>)}</ul>}
    </details>
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
