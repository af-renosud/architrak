import { useEffect, useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Check, ChevronDown, Circle, MessageSquare, ShieldAlert, ShieldCheck, ShieldX } from "lucide-react";
import { Amount } from "@/components/ui/amount";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { TechnicalLabel } from "@/components/ui/technical-label";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

export type PlanningReviewStatus = "unchecked" | "green" | "amber" | "red";
export type PlanningLineReview = {
  id: number;
  lineId: number;
  status: PlanningReviewStatus;
  notes?: string | null;
  reviewedBy?: string | null;
  reviewedAt?: string | null;
};

type ReviewLine = {
  id?: number;
  lineNumber: number;
  description: string;
  quantity: string;
  unit: string;
  unitPriceHt: string;
  totalHt: string;
};

const states: { key: PlanningReviewStatus; label: string; short: string; icon: typeof ShieldCheck; className: string }[] = [
  { key: "green", label: "Checked", short: "OK", icon: ShieldCheck, className: "text-emerald-700 border-emerald-200 bg-emerald-50 hover:bg-emerald-100 data-[active=true]:bg-emerald-600 data-[active=true]:text-white" },
  { key: "amber", label: "Check later", short: "Hold", icon: ShieldAlert, className: "text-amber-700 border-amber-200 bg-amber-50 hover:bg-amber-100 data-[active=true]:bg-amber-500 data-[active=true]:text-white" },
  { key: "red", label: "Flagged", short: "Flag", icon: ShieldX, className: "text-rose-700 border-rose-200 bg-rose-50 hover:bg-rose-100 data-[active=true]:bg-rose-600 data-[active=true]:text-white" },
];

export function PlanningLineReviewWorkspace({
  revisionId, version, lines, lineReviews = [], readOnly = false, onUpdated,
}: {
  revisionId: number;
  version: number;
  lines: ReviewLine[];
  lineReviews?: PlanningLineReview[];
  readOnly?: boolean;
  onUpdated?: (updated: { version?: number; lineReviews?: PlanningLineReview[] }) => void;
}) {
  const { toast } = useToast();
  const [reviews, setReviews] = useState<PlanningLineReview[]>(lineReviews);
  const [openNotes, setOpenNotes] = useState<number | null>(null);
  const [draftNotes, setDraftNotes] = useState<Record<number, string>>({});
  useEffect(() => setReviews(lineReviews), [lineReviews]);

  const save = useMutation({
    mutationFn: async ({ lineId, status, notes }: { lineId: number; status: PlanningReviewStatus; notes: string }) => {
      const response = await apiRequest("PATCH", `/api/planning-revisions/${revisionId}/lines/${lineId}/review`, { expectedVersion: version, status, notes });
      return response.json() as Promise<{ revision?: { version?: number }; version?: number; lineReviews?: PlanningLineReview[] }>;
    },
    onSuccess: (updated) => {
      if (updated.lineReviews) setReviews(updated.lineReviews);
      onUpdated?.({ version: updated.revision?.version ?? updated.version, lineReviews: updated.lineReviews });
    },
    onError: (error: Error) => toast({ title: "Line review could not be saved", description: error.message, variant: "destructive" }),
  });
  const reviewByLine = useMemo(() => new Map(reviews.map((review) => [review.lineId, review])), [reviews]);
  const counts = useMemo(() => ({
    checked: reviews.filter((r) => r.status === "green").length,
    flagged: reviews.filter((r) => r.status === "amber" || r.status === "red").length,
    total: lines.filter((line) => line.id != null).length,
  }), [reviews, lines]);

  const choose = (line: ReviewLine, status: PlanningReviewStatus) => {
    if (!line.id || readOnly || save.isPending) return;
    const current = reviewByLine.get(line.id);
    const notes = draftNotes[line.id] ?? current?.notes ?? "";
    save.mutate({ lineId: line.id, status: current?.status === status ? "unchecked" : status, notes });
  };

  return (
    <div className="flex min-h-0 flex-col gap-4" data-testid="planning-line-review-workspace">
      <div className="grid grid-cols-3 gap-2 rounded-xl border border-[#d8e1df] bg-[#f5f8f7] p-3">
        <div><TechnicalLabel>Review coverage</TechnicalLabel><p className="mt-1 text-lg font-semibold text-[#173b39]">{counts.checked}<span className="text-sm font-normal text-muted-foreground"> / {counts.total}</span></p><p className="text-[10px] text-muted-foreground">lines checked</p></div>
        <div className="border-l border-[#d8e1df] pl-3"><TechnicalLabel>Attention</TechnicalLabel><p className="mt-1 text-lg font-semibold text-amber-700">{counts.flagged}</p><p className="text-[10px] text-muted-foreground">lines flagged or held</p></div>
        <div className="border-l border-[#d8e1df] pl-3"><TechnicalLabel>Internal notes</TechnicalLabel><p className="mt-1 text-lg font-semibold text-[#173b39]">{reviews.filter((r) => r.notes?.trim()).length}</p><p className="text-[10px] text-muted-foreground">reviewer annotations</p></div>
      </div>
      <div className="overflow-x-auto rounded-xl border border-border/80 bg-card">
        <div className="hidden min-w-[760px] grid-cols-[3rem_minmax(18rem,1fr)_5.5rem_7rem_7.5rem_12rem] gap-3 border-b bg-[#f8faf9] px-4 py-2 text-[9px] font-semibold uppercase tracking-[0.16em] text-muted-foreground lg:grid">
          <span>#</span><span>Scope / description</span><span className="text-right">Qty</span><span className="text-right">Unit price</span><span className="text-right">Total HT</span><span className="text-center">Review</span>
        </div>
        {lines.map((line, index) => {
          if (!line.id) return <div key={`new-${index}`} className="flex items-center gap-3 border-b border-dashed px-4 py-3 text-xs text-muted-foreground"><span className="w-8 font-mono">{line.lineNumber}</span><span className="flex-1">{line.description || "New unsaved line"}</span><Badge variant="outline" className="text-[9px]">Save to review</Badge></div>;
          const review = reviewByLine.get(line.id);
          const noteOpen = openNotes === line.id;
          return <div key={line.id} className={`border-b last:border-b-0 transition-colors ${review?.status === "red" ? "bg-rose-50/35" : review?.status === "amber" ? "bg-amber-50/30" : review?.status === "green" ? "bg-emerald-50/20" : ""}`} data-testid={`planning-line-review-${line.id}`}>
            <div className="grid grid-cols-[2rem_minmax(0,1fr)] gap-3 px-4 py-3 lg:min-w-[760px] lg:grid-cols-[3rem_minmax(18rem,1fr)_5.5rem_7rem_7.5rem_12rem] lg:items-center">
              <span className="font-mono text-[11px] text-muted-foreground">{line.lineNumber}</span>
              <div className="min-w-0"><p className="break-words text-xs font-medium leading-5 text-foreground">{line.description || "Untitled line"}</p><p className="mt-0.5 text-[10px] text-muted-foreground lg:hidden">{line.quantity} {line.unit} · <Amount value={Number(line.totalHt || 0)} denomination="HT" /></p></div>
              <span className="hidden text-right font-mono text-[11px] lg:block">{line.quantity} <span className="text-muted-foreground">{line.unit}</span></span>
              <span className="hidden text-right font-mono text-[11px] lg:block"><Amount value={Number(line.unitPriceHt || 0)} denomination="HT" /></span>
              <span className="hidden text-right font-mono text-[11px] font-semibold lg:block"><Amount value={Number(line.totalHt || 0)} denomination="HT" /></span>
              <div className="col-span-2 flex flex-wrap items-center justify-between gap-2 lg:col-span-1 lg:justify-end">
                <div className="flex gap-1" role="group" aria-label={`Review line ${line.lineNumber}`}>
                  <button type="button" data-active={review?.status === "unchecked" || !review} aria-label="Not reviewed" title="Not reviewed" disabled={readOnly || save.isPending} onClick={() => choose(line, "unchecked")} className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-400 transition-transform hover:-translate-y-px data-[active=true]:border-slate-400 data-[active=true]:bg-slate-100"><Circle size={13} /></button>
                  {states.map(({ key, label, icon: Icon, className }) => <button key={key} type="button" data-active={review?.status === key} aria-label={label} title={label} disabled={readOnly || save.isPending} onClick={() => choose(line, key)} className={`inline-flex h-7 min-w-7 items-center justify-center rounded-md border px-1.5 text-[9px] font-bold transition-transform hover:-translate-y-px data-[active=true]:border-transparent ${className}`}><Icon size={13} /></button>)}
                </div>
                <Button type="button" variant="ghost" size="sm" className={`h-7 gap-1 px-2 text-[10px] ${review?.notes ? "text-[#173b39]" : "text-muted-foreground"}`} onClick={() => setOpenNotes(noteOpen ? null : line.id!)}><MessageSquare size={12} />{review?.notes ? "Note" : "Add note"}<ChevronDown size={11} className={noteOpen ? "rotate-180 transition-transform" : "transition-transform"} /></Button>
              </div>
            </div>
            {noteOpen && <div className="border-t border-border/50 bg-[#fbfcfb] px-4 py-3 sm:pl-12 lg:pl-16"><Textarea disabled={readOnly || save.isPending} value={draftNotes[line.id] ?? review?.notes ?? ""} onChange={(event) => setDraftNotes((current) => ({ ...current, [line.id!]: event.target.value }))} placeholder="Internal note for the project team…" className="min-h-[68px] resize-y bg-white text-xs" data-testid={`planning-line-review-note-${line.id}`} /><div className="mt-2 flex flex-wrap items-center justify-between gap-2"><span className="text-[10px] text-muted-foreground">{review?.reviewedAt ? `Last reviewed ${new Date(review.reviewedAt).toLocaleDateString("fr-FR")}` : "Internal only · never shared with supplier"}</span>{!readOnly && <Button type="button" size="sm" className="h-7 text-[10px]" disabled={save.isPending} onClick={() => save.mutate({ lineId: line.id!, status: review?.status ?? "unchecked", notes: draftNotes[line.id!] ?? review?.notes ?? "" })}><Check size={12} /> Save note</Button>}</div></div>}
          </div>;
        })}
      </div>
      <p className="text-[10px] text-muted-foreground"><span className="font-semibold text-foreground">Review controls are internal.</span> Green confirms the line, amber keeps it open, red flags a discrepancy. New lines become reviewable after saving the revision.</p>
    </div>
  );
}