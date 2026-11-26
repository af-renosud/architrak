import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ListChecks, Sparkles, Undo2, X, FileSpreadsheet, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { CHECK_CATEGORIES, type QuotationCheckPoint, type QuotationChecksResult } from "@shared/quotation-checks";
import { useWorksheetList, worksheetKey, worksheetListKey } from "./use-client-worksheet";

export const quotationChecksKey = (devisId: number) => ["/api/devis", devisId, "points-to-check"];
const fmtDate = (v: string) => new Date(v).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Paris" });
const ACTION_LABEL: Record<string, string> = { dismissed: "Dismissed", reopened: "Reopened", added_to_worksheet: "Added to worksheet notes" };

/**
 * Automatic points worth raising with the client or contractor. Rule points
 * are recomputed from the quotation's current lines on every load; AI
 * suggestions are optional and labelled. Nothing here changes the quotation.
 *
 * Inside a worksheet, `worksheetId` targets that worksheet and `beforeWorksheetChange`
 * lets the editor save pending edits first.
 */
export function QuotationChecksPanel({ devisId, isArchived, hasLines, linesSignature, worksheetId, beforeWorksheetChange, defaultOpen = false }: {
  devisId: number; isArchived: boolean; hasLines: boolean; linesSignature?: string;
  worksheetId?: number; beforeWorksheetChange?: () => Promise<void>; defaultOpen?: boolean;
}) {
  const { toast } = useToast();
  const [open, setOpen] = useState(defaultOpen);
  const [showDismissed, setShowDismissed] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const { data, isLoading, error } = useQuery<QuotationChecksResult>({ queryKey: quotationChecksKey(devisId), enabled: hasLines, staleTime: 0 });
  const { data: worksheets } = useWorksheetList(devisId, open && worksheetId == null && hasLines);
  const [target, setTarget] = useState<number | null>(null);
  useEffect(() => {
    if (linesSignature !== undefined) queryClient.invalidateQueries({ queryKey: quotationChecksKey(devisId) });
  }, [linesSignature, devisId]);
  useEffect(() => { if (target == null && worksheets?.length) setTarget(worksheets[0].id); }, [worksheets, target]);

  const readOnly = isArchived || !!data?.readOnlyReason;
  const act = async (label: string, path: string, body: Record<string, unknown> | undefined, done?: string) => {
    setBusy(label);
    try {
      const result = (await (await apiRequest("POST", `/api/devis/${devisId}/points-to-check${path}`, body)).json()) as QuotationChecksResult;
      queryClient.setQueryData(quotationChecksKey(devisId), result);
      if (done) toast({ title: done });
      return result;
    } catch (e) {
      toast({ title: "Not saved", description: (e as Error).message, variant: "destructive" });
      return null;
    } finally { setBusy(null); }
  };
  const toWorksheet = async (point: QuotationCheckPoint) => {
    const wsId = worksheetId ?? target;
    if (wsId == null) return;
    try { await beforeWorksheetChange?.(); } catch (e) {
      toast({ title: "Not added", description: `Your last worksheet change was not saved (${(e as Error).message}). Check the worksheet and try again.`, variant: "destructive" });
      return;
    }
    const result = await act(`ws:${point.key}`, "/to-worksheet", { key: point.key, worksheetId: wsId }, "Added to the worksheet notes");
    if (result) {
      queryClient.invalidateQueries({ queryKey: worksheetKey(wsId) });
      queryClient.invalidateQueries({ queryKey: worksheetListKey(devisId) });
    }
  };
  const runAi = async () => {
    const result = await act("ai", "/ai", undefined);
    if (result?.ai.status === "failed") toast({ title: "No AI suggestions", description: `${result.ai.error} The automatic points are unaffected.`, variant: "destructive" });
    else if (result) toast({ title: "AI suggestions updated" });
  };

  if (!hasLines) return null;
  const openCount = data?.open.length ?? 0;
  const rules = data?.open.filter(p => p.source === "rule") ?? [];
  const ai = data?.open.filter(p => p.source === "ai") ?? [];
  const canTarget = worksheetId != null || (worksheets?.length ?? 0) > 0;

  return (
    <div className="rounded-md border bg-white p-3" data-testid={`panel-quotation-checks-${devisId}`}>
      <div className="flex flex-wrap items-center gap-2">
        <ListChecks className="h-4 w-4 text-amber-700" />
        <p className="text-xs font-semibold">Points to check</p>
        <span className={`rounded-full px-1.5 text-[10px] font-semibold ${openCount ? "bg-amber-100 text-amber-800" : "bg-slate-100 text-slate-600"}`} data-testid={`count-quotation-checks-${devisId}`}>
          {isLoading ? "…" : `${openCount} open`}
        </span>
        <p className="flex-1 text-[11px] text-muted-foreground">Possible duplicates, unpriced lines, VAT and arithmetic to raise with the client or contractor. The quotation is never changed.</p>
        <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => setOpen(v => !v)} data-testid={`button-toggle-checks-${devisId}`}>
          {open ? "Hide" : "Show"}
        </Button>
      </div>
      {open && (
        <div className="mt-2 space-y-3">
          {error && <p className="text-[11px] text-rose-700">{(error as Error).message}</p>}
          {data && (
            <>
              {worksheetId == null && !readOnly && (
                <div className="flex flex-wrap items-center gap-2 text-[11px]">
                  {canTarget ? (
                    <label className="flex items-center gap-1 text-muted-foreground">Worksheet for notes
                      <select className="h-7 rounded border bg-white px-1.5 text-[11px]" value={target ?? ""} onChange={e => setTarget(Number(e.target.value))} data-testid={`select-checks-worksheet-${devisId}`}>
                        {worksheets?.map(w => <option key={w.id} value={w.id}>{w.title}</option>)}
                      </select>
                    </label>
                  ) : <span className="text-muted-foreground">Create a client worksheet to send points into its notes.</span>}
                </div>
              )}
              <PointList points={rules} empty="No automatic points on this quotation." devisId={devisId} readOnly={readOnly} busy={busy}
                sent={data.sentToWorksheet} canTarget={canTarget} onDismiss={(p, reason) => act(`d:${p.key}`, "/dismiss", { key: p.key, reason }, "Point dismissed")}
                onToWorksheet={toWorksheet} />

              <div className="rounded border border-dashed border-violet-300 bg-violet-50/40 p-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Sparkles className="h-3.5 w-3.5 text-violet-700" />
                  <p className="text-[11px] font-semibold text-violet-900">AI suggestions</p>
                  <p className="flex-1 text-[10px] text-violet-900/80">
                    Optional extra points (contractor annotations, overlapping scope). Suggestions only — check them against the PDF.
                    {data.ai.at && <> Last run {fmtDate(data.ai.at)}.</>}
                    {data.ai.stale && <span className="font-medium text-amber-800"> The quotation's lines have changed since; run again to refresh.</span>}
                  </p>
                  {!readOnly && data.ai.available && (
                    <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={runAi} disabled={busy != null} data-testid={`button-checks-ai-${devisId}`}>
                      {busy === "ai" ? <><Loader2 className="mr-1 h-3 w-3 animate-spin" />Asking…</> : data.ai.status === "none" ? "Ask for suggestions" : "Run again"}
                    </Button>
                  )}
                </div>
                {!data.ai.available && <p className="mt-1 text-[10px] text-muted-foreground">AI suggestions are not configured on this server.</p>}
                {data.ai.status === "failed" && <p className="mt-1 text-[10px] text-rose-700" data-testid={`text-checks-ai-error-${devisId}`}>Last attempt failed: {data.ai.error}</p>}
                {(ai.length > 0 || data.ai.status === "succeeded") && (
                  <div className="mt-2">
                    <PointList points={ai} empty="No further points suggested." devisId={devisId} readOnly={readOnly} busy={busy}
                      sent={data.sentToWorksheet} canTarget={canTarget} onDismiss={(p, reason) => act(`d:${p.key}`, "/dismiss", { key: p.key, reason }, "Suggestion dismissed")}
                      onToWorksheet={toWorksheet} />
                  </div>
                )}
              </div>

              {data.dismissed.length > 0 && (
                <div>
                  <Button size="sm" variant="ghost" className="h-6 px-1 text-[11px]" onClick={() => setShowDismissed(v => !v)} data-testid={`button-checks-dismissed-${devisId}`}>
                    {showDismissed ? "Hide" : "Show"} dismissed ({data.dismissed.length})
                  </Button>
                  {showDismissed && (
                    <ul className="mt-1 space-y-1">
                      {data.dismissed.map(p => (
                        <li key={p.key} className="rounded border bg-slate-50 px-2 py-1.5 text-[11px] text-muted-foreground" data-testid={`dismissed-check-${p.key}`}>
                          <span className="font-medium text-foreground">{CHECK_CATEGORIES[p.category]}</span>{p.source === "ai" && " (AI suggestion)"} · {p.finding}
                          <span className="block">Dismissed by {p.dismissedBy}, {fmtDate(p.dismissedAt)}{p.reason ? ` — “${p.reason}”` : ""}</span>
                          {!readOnly && (
                            <Button size="sm" variant="ghost" className="mt-0.5 h-6 px-1.5 text-[10px]" disabled={busy != null}
                              onClick={() => act(`r:${p.key}`, "/reopen", { key: p.key }, "Point reopened")}><Undo2 className="mr-1 h-3 w-3" />Reopen</Button>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
              {data.history.length > 0 && (
                <div>
                  <Button size="sm" variant="ghost" className="h-6 px-1 text-[11px]" onClick={() => setShowHistory(v => !v)} data-testid={`button-checks-history-${devisId}`}>
                    {showHistory ? "Hide" : "Show"} history ({data.history.length})
                  </Button>
                  {showHistory && (
                    <ul className="mt-1 space-y-0.5 text-[10px] text-muted-foreground">
                      {data.history.map(h => (
                        <li key={h.id}>
                          <span className="font-medium text-foreground">{ACTION_LABEL[h.action] ?? h.action}</span> · {CHECK_CATEGORIES[h.point.category]} · {h.actor} · {fmtDate(h.at)}
                          {h.reason && <> — “{h.reason}”</>}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
              {readOnly && <p className="text-[11px] text-muted-foreground">{data.readOnlyReason ?? "Archived projects are read-only."}</p>}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function PointList({ points, empty, devisId, readOnly, busy, sent, canTarget, onDismiss, onToWorksheet }: {
  points: QuotationCheckPoint[]; empty: string; devisId: number; readOnly: boolean; busy: string | null;
  sent: QuotationChecksResult["sentToWorksheet"]; canTarget: boolean;
  onDismiss: (p: QuotationCheckPoint, reason: string) => Promise<unknown>; onToWorksheet: (p: QuotationCheckPoint) => void;
}) {
  if (!points.length) return <p className="text-[11px] text-muted-foreground" data-testid={`text-checks-empty-${devisId}`}>{empty}</p>;
  return (
    <ul className="space-y-1.5">
      {points.map(p => <PointItem key={p.key} point={p} readOnly={readOnly} busy={busy} sent={sent[p.key]} canTarget={canTarget} onDismiss={onDismiss} onToWorksheet={onToWorksheet} />)}
    </ul>
  );
}

function PointItem({ point, readOnly, busy, sent, canTarget, onDismiss, onToWorksheet }: {
  point: QuotationCheckPoint; readOnly: boolean; busy: string | null; sent?: { worksheetId: number; at: string }; canTarget: boolean;
  onDismiss: (p: QuotationCheckPoint, reason: string) => Promise<unknown>; onToWorksheet: (p: QuotationCheckPoint) => void;
}) {
  const [dismissing, setDismissing] = useState(false);
  const [reason, setReason] = useState("");
  const ai = point.source === "ai";
  return (
    <li className={`rounded border px-2.5 py-2 text-[11px] ${ai ? "border-dashed border-violet-300 bg-white" : "bg-amber-50/40"}`} data-testid={`check-point-${point.key}`}>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${ai ? "bg-violet-100 text-violet-800" : "bg-amber-100 text-amber-900"}`}>{CHECK_CATEGORIES[point.category]}</span>
        {ai && <span className="rounded border border-violet-300 px-1 text-[9px] uppercase tracking-wide text-violet-700">AI suggestion</span>}
        {sent && <span className="text-[10px] text-emerald-700" data-testid={`text-check-sent-${point.key}`}><FileSpreadsheet className="mr-0.5 inline h-3 w-3" />In worksheet notes</span>}
      </div>
      <p className="mt-1 text-foreground">{point.finding}</p>
      <ul className="mt-1 space-y-0.5 text-[10px] text-muted-foreground">
        {point.lines.map(l => <li key={l.id}><span className="font-mono">Line {l.lineNumber}</span> · {l.lot} — {l.description}</li>)}
      </ul>
      <p className="mt-1 text-[10px]"><span className="font-semibold">Suggested action:</span> {point.suggestedAction}</p>
      {!readOnly && !dismissing && (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          <Button size="sm" variant="outline" className="h-6 px-2 text-[10px]" disabled={busy != null || !canTarget} onClick={() => onToWorksheet(point)}
            title={canTarget ? "Append this point to the notes of the lines involved" : "Create a client worksheet first"} data-testid={`button-check-to-worksheet-${point.key}`}>
            Add to worksheet notes
          </Button>
          <Button size="sm" variant="ghost" className="h-6 px-2 text-[10px]" disabled={busy != null} onClick={() => setDismissing(true)} data-testid={`button-check-dismiss-${point.key}`}>
            <X className="mr-0.5 h-3 w-3" />Dismiss
          </Button>
        </div>
      )}
      {dismissing && (
        <div className="mt-1.5 space-y-1">
          <Textarea rows={2} className="text-[11px]" placeholder="Why is this not an issue? (kept on record)" value={reason} onChange={e => setReason(e.target.value)} data-testid={`input-check-dismiss-reason-${point.key}`} />
          <div className="flex gap-1.5">
            <Button size="sm" className="h-6 px-2 text-[10px]" disabled={reason.trim().length < 3 || busy != null} data-testid={`button-check-dismiss-confirm-${point.key}`}
              onClick={async () => { if (await onDismiss(point, reason.trim())) { setDismissing(false); setReason(""); } }}>Dismiss point</Button>
            <Button size="sm" variant="ghost" className="h-6 px-2 text-[10px]" onClick={() => setDismissing(false)}>Cancel</Button>
          </div>
        </div>
      )}
    </li>
  );
}
