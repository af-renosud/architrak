import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, GitCompare, MessageSquare, Send, Share2 } from "lucide-react";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Amount } from "@/components/ui/amount";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import {
  COMPARISON_LABELS, type ComparisonStatus, type RevisionChange, type WorksheetComparison,
} from "@shared/worksheet-agreement";

const fmtDate = (v: string) => new Date(v).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Paris" });
const euros = (c: number) => c / 100;
const newRequestId = () => (typeof globalThis.crypto?.randomUUID === "function" ? globalThis.crypto.randomUUID()
  : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, ch => {
    const r = Math.floor(Math.random() * 16);
    return (ch === "x" ? r : (r & 0x3) | 0x8).toString(16);
  }));

interface ShareState {
  worksheetRevision: number; hasActiveLink: boolean; unreadComments: number; englishBlocker: string | null;
  releases: Array<{ id: number; worksheetRevision: number; sealedAt: string; sealedBy: string | null; withdrawnAt: string | null;
    withdrawnBy: string | null; current: boolean; revisedTtcCents: number;
    comments: Array<{ id: number; body: string; authorName: string | null; authorEmail: string; createdAt: string; acknowledgedAt: string | null }> }>;
}
interface RevisionPreview {
  worksheetRevision: number; contractorName: string; recipientEmail: string | null; changes: RevisionChange[];
  subject: string; body: string; canSend: boolean; reason: string | null;
}
interface RevisionRequestRow {
  id: number; worksheetRevision: number; subject: string; body: string; recipientEmail: string; changeCount: number;
  createdAt: string; createdBy: string | null; status: string; sentAt: string | null;
}
interface Candidates { replacementDevisId: number | null; candidates: Array<{ id: number; code: string; number: string | null; amountHt: string | null; lineCount: number }> }
interface ComparisonResponse {
  basis: { kind: "revision_request"; requestId: number; revision: number; at: string } | { kind: "worksheet"; revision: number };
  worksheetChangedSinceBasis: boolean;
  undeliveredRequest: { id: number; status: string; createdAt: string } | null;
  target: { id: number; code: string; number: string | null; amountHt: string | null; lineCount: number };
  agreedOriginalHtCents: number;
  comparison: WorksheetComparison;
}

const STATUS_LABEL: Record<string, string> = {
  queued: "Queued", sending: "Sending", sent: "Sent", failed: "Not sent", draft: "Draft", unknown: "Unknown",
};
const COMPARISON_STYLE: Record<ComparisonStatus, string> = {
  as_agreed: "bg-emerald-50 text-emerald-700 border-emerald-200",
  removed_as_agreed: "bg-slate-100 text-slate-600 border-slate-200",
  quantity_differs: "bg-amber-50 text-amber-800 border-amber-200",
  price_differs: "bg-amber-50 text-amber-800 border-amber-200",
  total_differs: "bg-amber-50 text-amber-800 border-amber-200",
  missing: "bg-rose-50 text-rose-700 border-rose-200",
  still_included: "bg-rose-50 text-rose-700 border-rose-200",
  not_in_worksheet: "bg-violet-50 text-violet-700 border-violet-200",
};

/**
 * After agreement in a client meeting: share a sealed English copy with the
 * client, ask the contractor (in French) for a revised quotation, and compare
 * the revised quotation with what was agreed.
 */
export function WorksheetAgreementPanel({ worksheetId, devisId, projectId, revision, readOnly, flush }: {
  worksheetId: number; devisId: number; projectId: number; revision: number; readOnly: boolean; flush: () => Promise<void>;
}) {
  return (
    <div className="grid gap-3 lg:grid-cols-3" data-testid={`worksheet-agreement-${worksheetId}`}>
      <ClientShareSection worksheetId={worksheetId} devisId={devisId} projectId={projectId} revision={revision} readOnly={readOnly} flush={flush} />
      <RevisionRequestSection worksheetId={worksheetId} devisId={devisId} readOnly={readOnly} flush={flush} />
      <ComparisonSection worksheetId={worksheetId} />
    </div>
  );
}

function Section({ icon, title, children, testId }: { icon: React.ReactNode; title: string; children: React.ReactNode; testId: string }) {
  return (
    <section className="rounded-md border bg-white p-3 text-xs" data-testid={testId}>
      <p className="mb-2 flex items-center gap-1.5 font-semibold">{icon}{title}</p>
      {children}
    </section>
  );
}

export function ClientShareSection({ worksheetId, devisId, projectId, revision, readOnly, flush }: {
  worksheetId: number; devisId: number; projectId: number; revision: number; readOnly: boolean; flush: () => Promise<void>;
}) {
  const { toast } = useToast();
  const key = ["/api/worksheets", worksheetId, "client-share"];
  // Link creation and client comments happen elsewhere: always refetch on open and poll while open.
  const { data } = useQuery<ShareState>({ queryKey: key, staleTime: 0, refetchOnMount: "always", refetchOnWindowFocus: true, refetchInterval: 30000 });
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: key });
    queryClient.invalidateQueries({ queryKey: ["/api/devis", devisId, "worksheets", "agreement-summary"] });
    queryClient.invalidateQueries({ queryKey: ["/api/worksheets", worksheetId] });
  };
  const act = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try { await fn(); toast({ title: done }); } catch (e) {
      toast({ title: "Not done", description: (e as Error).message, variant: "destructive" });
    } finally { setBusy(false); refresh(); }
  };
  const current = data?.releases.find(r => r.current) ?? null;
  const outdated = current != null && current.worksheetRevision !== revision;
  const share = () => act(async () => {
    await flush();
    await apiRequest("POST", `/api/worksheets/${worksheetId}/client-share`, { expectedRevision: revision });
  }, "Shared with the client");

  return (
    <Section icon={<Share2 className="h-3.5 w-3.5 text-sky-700" />} title="Share with the client" testId="section-worksheet-client-share">
      <p className="text-muted-foreground">The client sees a fixed English copy of the figures as they are when you share. Later edits only reach them when you share again.</p>
      {data && !data.hasActiveLink && <p className="mt-2 text-amber-800" data-testid="text-worksheet-no-link">This project has no active client link. Create one from Manage client link first.</p>}
      {data?.englishBlocker && <p className="mt-2 text-amber-800" data-testid="text-worksheet-english-blocker">{data.englishBlocker}</p>}
      {current ? (
        <div className="mt-2 rounded border bg-sky-50/60 p-2" data-testid="text-worksheet-shared-current">
          <p>Shared: version {current.worksheetRevision} · {fmtDate(current.sealedAt)}{current.sealedBy ? ` · ${current.sealedBy}` : ""}</p>
          {outdated && <p className="mt-1 font-medium text-amber-800" data-testid="text-worksheet-share-outdated">The worksheet has changed since. The client still sees the shared version.</p>}
          <div className="mt-1 flex flex-wrap gap-2">
            <a className="inline-flex items-center gap-1 text-sky-700 underline" target="_blank" rel="noreferrer"
              href={`/api/projects/${projectId}/client-share/preview/worksheets/${current.id}`} data-testid="link-worksheet-share-preview">
              <ExternalLink className="h-3 w-3" />Preview client view
            </a>
            <button type="button" className="text-rose-700 underline disabled:opacity-50" disabled={busy}
              onClick={() => { if (window.confirm("Stop sharing this worksheet? The client will no longer see any version of it. Shared copies stay on record.")) act(() => apiRequest("POST", `/api/worksheets/${worksheetId}/client-share/${current.id}/withdraw`), "Removed from the client link"); }}
              data-testid="button-worksheet-share-withdraw">Stop sharing</button>
          </div>
        </div>
      ) : data && <p className="mt-2 text-muted-foreground">Not shared yet.</p>}
      {!readOnly && data?.hasActiveLink && !data.englishBlocker && (!current || outdated) && (
        <Button size="sm" className="mt-2 h-7 text-[11px]" disabled={busy} onClick={() => setConfirming(true)} data-testid="button-worksheet-share">
          {current ? "Share the latest version" : "Share this version with the client"}
        </Button>
      )}
      <CommentsList data={data} worksheetId={worksheetId} onDone={refresh} />
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Share version {revision} with the client?</AlertDialogTitle>
            <AlertDialogDescription>
              A fixed copy of this worksheet, with its current figures, will appear on the client's project link. The client can read it and leave comments, but cannot change anything.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={share} data-testid="button-worksheet-share-confirm">Share</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Section>
  );
}

function CommentsList({ data, worksheetId, onDone }: { data: ShareState | undefined; worksheetId: number; onDone: () => void }) {
  const { toast } = useToast();
  const withComments = (data?.releases ?? []).filter(r => r.comments.length);
  if (!withComments.length) return null;
  return (
    <div className="mt-3 space-y-2" data-testid="list-worksheet-client-comments">
      <p className="flex items-center gap-1 font-semibold"><MessageSquare className="h-3.5 w-3.5" />Client comments
        {data!.unreadComments > 0 && <span className="rounded-full bg-amber-100 px-1.5 text-[10px] text-amber-800" data-testid="badge-worksheet-unread">{data!.unreadComments} new</span>}</p>
      {withComments.map(r => {
        const unread = r.comments.filter(c => !c.acknowledgedAt).length;
        return (
          <div key={r.id} className="rounded border p-2">
            <p className="text-[10px] text-muted-foreground">On version {r.worksheetRevision}{r.withdrawnAt ? " (no longer shared)" : ""}</p>
            {r.comments.map(c => (
              <div key={c.id} className={`mt-1 rounded px-2 py-1 ${c.acknowledgedAt ? "bg-slate-50" : "bg-amber-50"}`} data-testid={`worksheet-comment-${c.id}`}>
                <p className="text-[10px] text-muted-foreground">{c.authorName ?? c.authorEmail} · {fmtDate(c.createdAt)}</p>
                <p className="whitespace-pre-wrap break-words">{c.body}</p>
              </div>
            ))}
            {unread > 0 && (
              <Button size="sm" variant="ghost" className="mt-1 h-6 px-2 text-[10px]" data-testid={`button-worksheet-comments-read-${r.id}`}
                onClick={() => apiRequest("POST", `/api/worksheets/${worksheetId}/client-share/${r.id}/acknowledge`).then(onDone)
                  .catch(e => toast({ title: "Not saved", description: (e as Error).message, variant: "destructive" }))}>
                Mark as read
              </Button>
            )}
          </div>
        );
      })}
    </div>
  );
}

function RevisionRequestSection({ worksheetId, devisId, readOnly, flush }: { worksheetId: number; devisId: number; readOnly: boolean; flush: () => Promise<void> }) {
  const { toast } = useToast();
  const listKey = ["/api/worksheets", worksheetId, "revision-requests"];
  const { data: requests } = useQuery<RevisionRequestRow[]>({ queryKey: listKey, refetchInterval: q => ((q.state.data as RevisionRequestRow[] | undefined)?.some(r => ["queued", "sending"].includes(r.status)) ? 4000 : false) });
  const [open, setOpen] = useState(false);
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: listKey });
    queryClient.invalidateQueries({ queryKey: ["/api/devis", devisId, "worksheets", "agreement-summary"] });
    queryClient.invalidateQueries({ queryKey: ["/api/worksheets", worksheetId] });
  };
  const retry = (id: number) => apiRequest("POST", `/api/worksheets/${worksheetId}/revision-requests/${id}/retry`).then(r => r.json())
    .then((r: { status: string; message: string | null }) => toast({ title: r.status === "sent" ? "Revision request sent" : "Not confirmed as sent", description: r.message ?? undefined, variant: r.status === "failed" ? "destructive" : undefined }))
    .catch(e => toast({ title: "Not sent", description: (e as Error).message, variant: "destructive" }))
    .finally(refresh);

  return (
    <Section icon={<Send className="h-3.5 w-3.5 text-emerald-700" />} title="Ask the contractor for a revised quotation" testId="section-worksheet-revision-request">
      <p className="text-muted-foreground">Sends the contractor a request in French listing the added, removed and changed lines with quantities.</p>
      {!readOnly && <Button size="sm" variant="outline" className="mt-2 h-7 text-[11px]" onClick={() => setOpen(true)} data-testid="button-worksheet-revision-prepare">Prepare request…</Button>}
      {requests && requests.length > 0 && (
        <ul className="mt-2 space-y-1" data-testid="list-worksheet-revision-requests">
          {requests.map(r => (
            <li key={r.id} className="rounded border px-2 py-1" data-testid={`worksheet-revision-request-${r.id}`}>
              <p><span className={`font-medium ${r.status === "failed" ? "text-rose-700" : r.status === "sent" ? "text-emerald-700" : ""}`}>{STATUS_LABEL[r.status] ?? r.status}</span>
                {" "}· version {r.worksheetRevision} · {r.changeCount} change{r.changeCount === 1 ? "" : "s"} · {r.recipientEmail}</p>
              <p className="text-[10px] text-muted-foreground">{fmtDate(r.sentAt ?? r.createdAt)}{r.createdBy ? ` · ${r.createdBy}` : ""}</p>
              <details><summary className="cursor-pointer text-[10px] text-muted-foreground">Text sent</summary>
                <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap rounded bg-slate-50 p-2 font-sans text-[11px]">{r.body}</pre></details>
              {r.status === "failed" && !readOnly && <Button size="sm" variant="ghost" className="h-6 px-2 text-[10px]" onClick={() => retry(r.id)} data-testid={`button-worksheet-revision-retry-${r.id}`}>Retry sending</Button>}
            </li>
          ))}
        </ul>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
          <DialogTitle>Request a revised quotation</DialogTitle>
          <DialogDescription>Check the French text, then send it to the contractor. It is recorded on this quotation.</DialogDescription>
          {open && <RevisionRequestForm worksheetId={worksheetId} flush={flush} onSent={() => { setOpen(false); refresh(); }} />}
        </DialogContent>
      </Dialog>
    </Section>
  );
}

function RevisionRequestForm({ worksheetId, flush, onSent }: { worksheetId: number; flush: () => Promise<void>; onSent: () => void }) {
  const { toast } = useToast();
  const [message, setMessage] = useState("");
  const [includeNotes, setIncludeNotes] = useState(false);
  const [preview, setPreview] = useState<RevisionPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [requestId] = useState(newRequestId);
  // Wording the current preview was built with.
  const previewMessage = useRef("");
  const previewNotes = useRef(false);
  const load = async (opts: { message: string; includeNotes: boolean }) => {
    setLoading(true);
    try {
      await flush();
      const res = await apiRequest("POST", `/api/worksheets/${worksheetId}/revision-requests/preview`, { message: opts.message || null, includeNotes: opts.includeNotes });
      setPreview(await res.json());
    } catch (e) { toast({ title: "Preview unavailable", description: (e as Error).message, variant: "destructive" }); }
    finally { setLoading(false); }
  };
  useEffect(() => { load({ message: "", includeNotes: false }); /* first preview */ }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const stale = preview != null && (message !== previewMessage.current || includeNotes !== previewNotes.current);
  const send = async () => {
    if (!preview) return;
    setSending(true);
    try {
      const res = await apiRequest("POST", `/api/worksheets/${worksheetId}/revision-requests`, {
        expectedRevision: preview.worksheetRevision, requestId, message: message || null, includeNotes,
      });
      const r = (await res.json()) as { status: string; message: string | null };
      toast({ title: r.status === "sent" ? "Revision request sent" : r.status === "failed" ? "Saved, but not confirmed as sent" : "Sending…",
        description: r.message ?? undefined, variant: r.status === "failed" ? "destructive" : undefined });
      onSent();
    } catch (e) { toast({ title: "Not sent", description: (e as Error).message, variant: "destructive" }); }
    finally { setSending(false); }
  };
  return (
    <div className="space-y-3 text-xs">
      <label className="block">
        <span className="font-medium">Additional message (French, optional)</span>
        <Textarea className="mt-1 text-xs" rows={3} maxLength={3000} value={message} onChange={e => setMessage(e.target.value)} data-testid="input-worksheet-revision-message" />
      </label>
      <label className="flex items-center gap-2">
        <Checkbox checked={includeNotes} onCheckedChange={v => setIncludeNotes(v === true)} data-testid="checkbox-worksheet-revision-notes" />
        Include the line notes (they are written for the client meeting; check they suit the contractor)
      </label>
      <Button size="sm" variant="outline" disabled={loading} onClick={() => { previewMessage.current = message; previewNotes.current = includeNotes; load({ message, includeNotes }); }} data-testid="button-worksheet-revision-refresh">
        {loading ? "Preparing…" : "Update preview"}
      </Button>
      {preview && (
        <div className="space-y-2">
          <p><span className="font-medium">To:</span> {preview.contractorName} {preview.recipientEmail ? `<${preview.recipientEmail}>` : "(no email)"}</p>
          <p><span className="font-medium">Subject:</span> {preview.subject}</p>
          <p className="text-muted-foreground">Based on worksheet version {preview.worksheetRevision} · {preview.changes.length} change{preview.changes.length === 1 ? "" : "s"}</p>
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded border bg-slate-50 p-3 font-sans text-[11px]" data-testid="text-worksheet-revision-body">{preview.body}</pre>
          {preview.reason && <p className="font-medium text-rose-700" data-testid="text-worksheet-revision-blocked">{preview.reason}</p>}
          {stale && <p className="text-amber-800">Update the preview to see your latest wording before sending.</p>}
          <Button size="sm" disabled={!preview.canSend || sending || loading || stale} onClick={send} data-testid="button-worksheet-revision-send">
            <Send className="mr-1.5 h-3.5 w-3.5" />{sending ? "Sending…" : "Send to the contractor"}
          </Button>
        </div>
      )}
    </div>
  );
}

function ComparisonSection({ worksheetId }: { worksheetId: number }) {
  // New quotations can arrive at any time: always refetch on mount.
  const { data: candidates } = useQuery<Candidates>({ queryKey: ["/api/worksheets", worksheetId, "comparison-candidates"], staleTime: 0, refetchOnMount: "always" });
  const [target, setTarget] = useState<number | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (target == null && candidates) setTarget(candidates.replacementDevisId ?? candidates.candidates[0]?.id ?? null);
  }, [candidates, target]);
  return (
    <Section icon={<GitCompare className="h-3.5 w-3.5 text-violet-700" />} title="Compare with the revised quotation" testId="section-worksheet-comparison">
      <p className="text-muted-foreground">When the contractor's revised quotation arrives, check it against what was agreed.</p>
      {candidates && candidates.candidates.length === 0 && <p className="mt-2 text-muted-foreground">No other quotation from this contractor in the project yet.</p>}
      {candidates && candidates.candidates.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <select className="h-7 max-w-full rounded border px-1 text-[11px]" value={target ?? ""} onChange={e => setTarget(Number(e.target.value))} data-testid="select-worksheet-comparison-target">
            {candidates.candidates.map(c => (
              <option key={c.id} value={c.id}>{c.number ?? c.code}{c.id === candidates.replacementDevisId ? " — replacement" : ""} · {c.lineCount} lines</option>
            ))}
          </select>
          <Button size="sm" variant="outline" className="h-7 text-[11px]" disabled={target == null} onClick={() => setOpen(true)} data-testid="button-worksheet-compare">Compare</Button>
        </div>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] max-w-5xl overflow-y-auto">
          <DialogTitle>Revised quotation vs agreed worksheet</DialogTitle>
          <DialogDescription>Lines are matched by their wording. Check anything not matched against the PDF.</DialogDescription>
          {open && target != null && <ComparisonView worksheetId={worksheetId} targetId={target} />}
        </DialogContent>
      </Dialog>
    </Section>
  );
}

export function ComparisonView({ worksheetId, targetId }: { worksheetId: number; targetId: number }) {
  // Under the worksheet's key prefix so worksheet/request refreshes invalidate it; recomputed each time the dialog opens.
  const { data, isLoading, isFetching, error } = useQuery<ComparisonResponse>({
    queryKey: ["/api/worksheets", worksheetId, "comparison", targetId], staleTime: 0, gcTime: 0, refetchOnMount: "always",
  });
  const [onlyDifferences, setOnlyDifferences] = useState(true);
  const rows = useMemo(() => (data?.comparison.rows ?? []).filter(r => !onlyDifferences || !["as_agreed", "removed_as_agreed"].includes(r.status)), [data, onlyDifferences]);
  if (isLoading || (isFetching && !data)) return <p className="text-xs text-muted-foreground">Comparing…</p>;
  if (error || !data) return <p className="text-xs text-rose-700">{(error as Error)?.message ?? "Comparison unavailable."}</p>;
  const c = data.comparison;
  const differences = Object.entries(c.counts).filter(([k, n]) => n > 0 && !["as_agreed", "removed_as_agreed"].includes(k)).reduce((s, [, n]) => s + n, 0);
  const totalDiff = c.revisedLinesHtCents - c.agreedHtCents;
  return (
    <div className="space-y-3 text-xs" data-testid="worksheet-comparison">
      <p className="text-muted-foreground">
        Agreed figures: {data.basis.kind === "revision_request" ? `as sent to the contractor on ${fmtDate(data.basis.at)} (version ${data.basis.revision})` : `current worksheet (version ${data.basis.revision}) — no revision request has been confirmed as sent`}.
        {" "}Revised quotation: {data.target.number ?? data.target.code} · {data.target.lineCount} lines.
      </p>
      {data.undeliveredRequest && <p className="font-medium text-amber-800" data-testid="text-worksheet-comparison-undelivered">
        A later revision request ({fmtDate(data.undeliveredRequest.createdAt)}) is {STATUS_LABEL[data.undeliveredRequest.status]?.toLowerCase() ?? data.undeliveredRequest.status}; it is not used until the contractor has received it.</p>}
      {data.worksheetChangedSinceBasis && <p className="font-medium text-amber-800">The worksheet has changed since the request was sent; the comparison uses the figures that were sent.</p>}
      <div className="grid gap-2 sm:grid-cols-3">
        <div className="rounded border p-2"><p className="text-[10px] uppercase text-muted-foreground">Agreed</p><p className="text-sm font-semibold"><Amount value={euros(c.agreedHtCents)} denomination="HT" /></p></div>
        <div className="rounded border p-2"><p className="text-[10px] uppercase text-muted-foreground">Revised quotation (lines)</p><p className="text-sm font-semibold"><Amount value={euros(c.revisedLinesHtCents)} denomination="HT" /></p>
          {data.target.amountHt != null && Math.round(Number(data.target.amountHt) * 100) !== c.revisedLinesHtCents && <p className="text-[10px] text-amber-800">Document total: <Amount value={Number(data.target.amountHt)} denomination="HT" /></p>}</div>
        <div className="rounded border p-2" data-testid="text-worksheet-comparison-difference"><p className="text-[10px] uppercase text-muted-foreground">Difference</p>
          <p className={`text-sm font-semibold ${totalDiff === 0 ? "text-emerald-700" : "text-amber-800"}`}>{totalDiff > 0 ? "+" : ""}<Amount value={euros(totalDiff)} denomination="HT" /></p></div>
      </div>
      <p data-testid="text-worksheet-comparison-summary">
        {differences === 0 ? <span className="font-medium text-emerald-700">Every line matches what was agreed.</span>
          : <span className="font-medium text-amber-800">{differences} point{differences === 1 ? "" : "s"} to check.</span>}
        {" "}{Object.entries(c.counts).filter(([, n]) => n > 0).map(([k, n]) => `${COMPARISON_LABELS[k as ComparisonStatus]}: ${n}`).join(" · ")}
      </p>
      <label className="flex items-center gap-2"><Checkbox checked={onlyDifferences} onCheckedChange={v => setOnlyDifferences(v === true)} />Show differences only</label>
      <table className="w-full border-collapse" data-testid="table-worksheet-comparison">
        <thead className="bg-slate-800 text-[10px] uppercase text-white">
          <tr><th className="px-1.5 py-1.5 text-left">Item</th><th className="px-1.5 text-left">Agreed</th><th className="px-1.5 text-right">Qty</th><th className="px-1.5 text-right">Total HT</th>
            <th className="px-1.5 text-left">Revised quotation</th><th className="px-1.5 text-right">Qty</th><th className="px-1.5 text-right">Total HT</th><th className="px-1.5 text-left">Result</th></tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b align-top" data-testid={`row-worksheet-comparison-${i}`}>
              <td className="px-1.5 py-1">{r.item ?? "—"}</td>
              <td className="px-1.5 py-1">{r.agreed ? <>{r.agreed.description}{r.agreed.status === "Removed" && <span className="ml-1 text-rose-700">(removed)</span>}</> : "—"}</td>
              <td className="px-1.5 py-1 text-right">{r.agreed?.quantity != null ? `${Number(r.agreed.quantity)}${r.agreed.unit ? ` ${r.agreed.unit}` : ""}` : "—"}</td>
              <td className="px-1.5 py-1 text-right">{r.agreed?.totalCents != null ? <Amount value={euros(r.agreed.totalCents)} denomination="none" /> : "—"}</td>
              <td className="px-1.5 py-1">{r.revised ? <>{r.revised.description}<span className="ml-1 text-[10px] text-muted-foreground">line {r.revised.lineNumber}{r.match === "similar" ? " · probable match" : ""}</span></> : "—"}</td>
              <td className="px-1.5 py-1 text-right">{r.revised?.quantity != null ? `${Number(r.revised.quantity)}${r.revised.unit ? ` ${r.revised.unit}` : ""}` : "—"}</td>
              <td className="px-1.5 py-1 text-right">{r.revised?.totalCents != null ? <Amount value={euros(r.revised.totalCents)} denomination="none" /> : "—"}</td>
              <td className="px-1.5 py-1"><span className={`inline-block rounded-full border px-2 text-[10px] font-medium ${COMPARISON_STYLE[r.status]}`}>{COMPARISON_LABELS[r.status]}</span></td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={8} className="py-3 text-center text-muted-foreground">No differences.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
